import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionMetaLine,
  findLatestSessionStateFromTail,
  openSessionWriter,
  readSessionEvents,
  resolveV2SessionPath,
} from "./sessionJsonlStore";
import { openSessionRecorder } from "./sessionRecorder";
import {
  listSessions,
  loadSession,
  resolveWorkspaceDir,
  resumeSession,
  type SessionBudget,
  type SessionRecord,
} from "./sessionStore";

describe("mixed-format session store", () => {
  let tmpDir: string;
  let sessionsRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-facade-"));
    sessionsRoot = path.join(tmpDir, "sessions");
    workspaceRoot = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const budget: SessionBudget = {
    totalTokens: 30,
    promptTokens: 20,
    completionTokens: 10,
    cacheReadTokens: 2,
    callCount: 2,
    costs: {},
    lastContextTokens: 12,
    lastCacheReadTokens: 2,
  };

  async function writeV1(
    id: string,
    messages: Message[],
    options: { budget?: SessionBudget; updatedAt?: number } = {},
  ): Promise<string> {
    const dir = resolveWorkspaceDir(workspaceRoot, sessionsRoot);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.json`);
    const record: SessionRecord = {
      meta: {
        id,
        workspaceRoot,
        title: "legacy title",
        createdAt: 10,
        updatedAt: options.updatedAt ?? 20,
        turns: messages.filter((message) => message.role === "user").length,
        traceIds: ["legacy-trace"],
        ...(options.budget ? { budget: options.budget } : {}),
      },
      messages,
    };
    await fs.writeFile(filePath, JSON.stringify(record), "utf8");
    return filePath;
  }

  it("lazily migrates a complete V1 snapshot and leaves the source untouched", async () => {
    const messages: Message[] = [
      { role: "user", content: "inspect it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      },
      { role: "tool", tool_call_id: "call-1", name: "read_file", content: "contents" },
      { role: "assistant", content: '{"reply":"done"}' },
    ];
    const v1Path = await writeV1("legacy-1", messages, { budget });
    const before = await fs.readFile(v1Path, "utf8");
    expect(await listSessions(workspaceRoot, { sessionsRoot })).toHaveLength(1);
    await expect(fs.access(v1Path.replace(/\.json$/, ".jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const migrated = await resumeSession(workspaceRoot, "legacy-1", {
      sessionsRoot,
      originator: "test",
      appVersion: "1.0.0",
    });

    expect(migrated).toMatchObject({
      meta: { id: "legacy-1", turns: 1, budget },
      messages,
    });
    expect(migrated?.transcript?.map((item) => item.type)).toEqual(["user", "tool", "assistant"]);
    expect(await fs.readFile(v1Path, "utf8")).toBe(before);
    const stored = await readSessionEvents(workspaceRoot, "legacy-1", { sessionsRoot });
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]).toMatchObject({
      type: "legacy_snapshot",
      sourceSchemaVersion: 1,
      legacyMeta: { traceIds: ["legacy-trace"], budget },
      messages,
    });
  });

  it("migrates old records without a budget", async () => {
    await writeV1("no-budget", [{ role: "user", content: "hello" }]);
    const record = await resumeSession(workspaceRoot, "no-budget", {
      sessionsRoot,
      originator: "test",
      appVersion: "1.0.0",
    });
    expect(record?.meta.budget).toBeUndefined();
  });

  it("warns when a compacted V1 snapshot has already lost earlier history", async () => {
    await writeV1("compacted", [
      {
        role: "user",
        content:
          "[Context was automatically compacted to fit the model window.]\n" +
          "<compaction_summary>summary</compaction_summary>",
      },
      { role: "user", content: "<prior_user_message>\nretained task\n</prior_user_message>" },
      { role: "assistant", content: '{"reply":"answer"}' },
    ]);
    const record = await resumeSession(workspaceRoot, "compacted", {
      sessionsRoot,
      originator: "test",
      appVersion: "1.0.0",
    });
    expect(record?.meta.turns).toBe(1);
    expect(record?.warnings?.[0]).toContain("cannot be recovered");
    expect(
      record?.transcript?.flatMap((item) =>
        item.type === "user" || item.type === "assistant" ? [item.content] : [],
      ),
    ).toEqual(["retained task", "answer"]);
  });

  it("does not fall back to V1 when the same id has a corrupt V2 file", async () => {
    const v1Path = await writeV1("fallback", [{ role: "user", content: "legacy survives" }]);
    await fs.writeFile(v1Path.replace(/\.json$/, ".jsonl"), '{"type":"session_meta"}\n', "utf8");

    await expect(
      resumeSession(workspaceRoot, "fallback", {
        sessionsRoot,
        originator: "test",
        appVersion: "1.0.0",
      }),
    ).rejects.toMatchObject({ kind: "corrupt", format: "v2", sessionId: "fallback" });
  });

  it("surfaces corrupt V2 when no V1 source exists", async () => {
    const dir = resolveWorkspaceDir(workspaceRoot, sessionsRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "broken.jsonl"), '{"type":"session_meta"}\n', "utf8");

    await expect(loadSession(workspaceRoot, "broken", { sessionsRoot })).rejects.toMatchObject({
      kind: "corrupt",
      format: "v2",
      sessionId: "broken",
    });
  });

  it("fails resume on non-ENOENT migration access errors and keeps V1 untouched", async () => {
    const v1Path = await writeV1("unreadable-migration", [
      { role: "user", content: "keep legacy" },
    ]);
    const access = vi.spyOn(fs, "access").mockRejectedValueOnce(
      Object.assign(new Error("access denied"), {
        code: "EACCES",
      }),
    );

    await expect(
      resumeSession(workspaceRoot, "unreadable-migration", {
        sessionsRoot,
        originator: "test",
        appVersion: "1.0.0",
      }),
    ).rejects.toMatchObject({ kind: "unreadable", format: "v2" });
    await expect(fs.access(v1Path.replace(/\.json$/, ".jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    access.mockRestore();
  });

  it("ignores corrupt V1 JSON and de-duplicates ids with valid V2 priority", async () => {
    const dir = resolveWorkspaceDir(workspaceRoot, sessionsRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "corrupt.json"), "{not-json", "utf8");
    await writeV1("duplicate", [{ role: "user", content: "legacy" }], { updatedAt: 999_999 });

    const recorder = await openSessionRecorder({
      workspaceRoot,
      sessionId: "duplicate",
      traceId: "v2-trace",
      originator: "test",
      appVersion: "1.0.0",
      modelId: "test-model",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await recorder.recordMessage(
      "turn-1",
      { kind: "user_input", inputKind: "initial" },
      { role: "user", content: "v2 wins" },
    );
    await recorder.completeTurn("turn-1", "completed");
    await recorder.endSegment({ status: "completed", reason: "exit" });
    await recorder.close();

    const listed = await listSessions(workspaceRoot, { sessionsRoot });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "duplicate",
      title: "v2 wins",
      turns: 1,
      traceIds: ["v2-trace"],
    });
    expect((await loadSession(workspaceRoot, "duplicate", { sessionsRoot }))?.messages).toEqual([
      { role: "user", content: "v2 wins" },
    ]);
  });

  it("replays V2 listing metadata when durable suffix events follow the latest state", async () => {
    const recorder = await openSessionRecorder({
      workspaceRoot,
      sessionId: "suffix",
      traceId: "trace-1",
      originator: "test",
      appVersion: "1.0.0",
      modelId: "test-model",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await recorder.endSegment({ status: "completed", reason: "exit", budget });
    await recorder.close();

    const suffixBudget = { ...budget, totalTokens: 99 };
    const writer = await openSessionWriter(
      createSessionMetaLine({
        sessionId: "suffix",
        workspaceRoot,
        originator: "test",
        appVersion: "1.0.0",
      }),
      { sessionsRoot },
    );
    await writer.append({ type: "budget_updated", budget: suffixBudget });
    await writer.close();

    expect(await listSessions(workspaceRoot, { sessionsRoot })).toMatchObject([
      { id: "suffix", budget: suffixBudget },
    ]);
  });

  it("uses a final interrupted state as the current listing checkpoint without replaying history", async () => {
    const recorder = await openSessionRecorder({
      workspaceRoot,
      sessionId: "idle-abort",
      traceId: "trace-1",
      originator: "test",
      appVersion: "1.0.0",
      modelId: "test-model",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await recorder.endSegment({ status: "interrupted", reason: "abort" });
    await recorder.close();

    const checkpoint = await findLatestSessionStateFromTail(workspaceRoot, "idle-abort", {
      sessionsRoot,
    });
    expect(checkpoint?.event).toMatchObject({
      type: "session_state",
      status: "interrupted",
    });

    // A current listing checkpoint deliberately makes picker metadata independent of historical
    // replay. Corrupting a covered middle event therefore breaks strict resume, but not listing.
    const filePath = resolveV2SessionPath(workspaceRoot, "idle-abort", { sessionsRoot });
    const lines = (await fs.readFile(filePath, "utf8")).split("\n");
    lines[1] = "{not-json";
    await fs.writeFile(filePath, lines.join("\n"), "utf8");

    await expect(listSessions(workspaceRoot, { sessionsRoot })).resolves.toMatchObject([
      {
        id: "idle-abort",
        title: "(untitled)",
        turns: 0,
        traceIds: ["trace-1"],
      },
    ]);
    await expect(loadSession(workspaceRoot, "idle-abort", { sessionsRoot })).rejects.toThrow(
      /corrupt/i,
    );
  });
});
