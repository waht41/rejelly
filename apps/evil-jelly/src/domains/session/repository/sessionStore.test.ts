import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordInitialTextInput } from "../__tests__/sessionTestInput";
import { persistSessionBlob } from "../journal/sessionBlobStore";
import {
  createSessionMetaLine,
  findLatestSessionStateFromTail,
  openSessionWriter,
  readSessionEvents,
  resolveV2SessionPath,
  resolveV3SessionPath,
} from "../journal/sessionJsonlStore";
import { resolveWorkspaceDir } from "../journal/sessionPaths";
import {
  acquireSessionWriterLock,
  releaseSessionWriterLock,
  SessionWriterLockedError,
} from "../journal/sessionWriterLock";
import { isKnownSessionEvent } from "../model/sessionEvents";
import { openSessionRecorder } from "../recorder/sessionRecorder";
import { materializeMessageHistory } from "./sessionMessageMaterializer";
import {
  listSessions,
  loadSession,
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
      mcpSelection: [],
      mcpToolGrants: [],
    };
    await fs.writeFile(filePath, JSON.stringify(record), "utf8");
    return filePath;
  }

  async function writeV2(id: string): Promise<{ filePath: string; bytes: string }> {
    const filePath = resolveV2SessionPath(workspaceRoot, id, { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lines = [
      {
        type: "session_meta",
        schemaVersion: 2,
        sessionId: id,
        workspaceRoot,
        createdAt: 10,
        originator: "v2-test",
        appVersion: "0.9.0",
      },
      {
        type: "run_segment_started",
        seq: 1,
        timestamp: 11,
        kind: "created",
        traceId: "v2-trace",
        modelId: "old-model",
        cwd: workspaceRoot,
      },
      {
        type: "message_recorded",
        seq: 2,
        timestamp: 12,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "initial" },
        message: {
          role: "user",
          content: "frozen V2 model input",
          extra: {
            rejelly: {
              kind: "user_input",
              display: {
                text: "review @src/a.ts",
                attachments: [
                  {
                    type: "file",
                    label: "src/a.ts",
                    action: "read",
                    locator: { scope: "workspace", path: "src/a.ts" },
                  },
                ],
              },
            },
          },
        },
      },
      {
        type: "message_recorded",
        seq: 3,
        timestamp: 13,
        turnId: "turn-1",
        source: { kind: "model" },
        message: { role: "assistant", content: "done" },
      },
      {
        type: "turn_completed",
        seq: 4,
        timestamp: 14,
        turnId: "turn-1",
        status: "completed",
      },
      {
        type: "session_state",
        seq: 5,
        timestamp: 15,
        coveredThroughSeq: 4,
        userTurns: 1,
        title: "review @src/a.ts",
        traceIds: ["v2-trace"],
        status: "active",
      },
    ];
    const bytes = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    await fs.writeFile(filePath, bytes, "utf8");
    return { filePath, bytes };
  }

  async function writeV2Image(id: string): Promise<void> {
    const bytes = Buffer.from("legacy-image-bytes");
    const blobRoot = path.join(tmpDir, "blobs");
    const blob = await persistSessionBlob(bytes, "image/png", { blobRoot });
    const filePath = resolveV2SessionPath(workspaceRoot, id, { sessionsRoot });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lines = [
      {
        type: "session_meta",
        schemaVersion: 2,
        sessionId: id,
        workspaceRoot,
        createdAt: 10,
        originator: "v2-test",
        appVersion: "0.9.0",
      },
      {
        type: "run_segment_started",
        seq: 1,
        timestamp: 11,
        kind: "created",
        traceId: "v2-image-trace",
        modelId: "old-model",
        cwd: workspaceRoot,
      },
      {
        type: "message_recorded",
        seq: 2,
        timestamp: 12,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "initial" },
        message: {
          role: "user",
          content: [
            { type: "text", text: "[Image #1]" },
            { type: "image", image: { url: blob.blobRef, detail: "high" } },
          ],
          extra: {
            rejelly: {
              kind: "user_input",
              display: { text: "[Image #1]", attachments: [] },
              imageBlobs: { [blob.blobRef]: blob },
            },
          },
        },
      },
      {
        type: "turn_completed",
        seq: 3,
        timestamp: 13,
        turnId: "turn-1",
        status: "completed",
      },
      {
        type: "session_state",
        seq: 4,
        timestamp: 14,
        coveredThroughSeq: 3,
        userTurns: 1,
        title: "[Image #1]",
        traceIds: ["v2-image-trace"],
        status: "active",
      },
    ];
    await fs.writeFile(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
  }

  it("migrates V2 to a separate V3 journal without inferring semantic tokens", async () => {
    const source = await writeV2("v2-rich-display");

    const resumed = await resumeSession(workspaceRoot, "v2-rich-display", {
      sessionsRoot,
      originator: "test",
      appVersion: "1.0.0",
    });

    expect(resumed).toMatchObject({
      meta: { title: "review @src/a.ts", turns: 1, traceIds: ["v2-trace"] },
      messages: [
        { role: "user", content: "frozen V2 model input" },
        { role: "assistant", content: "done" },
      ],
    });
    expect(await fs.readFile(source.filePath, "utf8")).toBe(source.bytes);
    await expect(
      fs.stat(resolveV3SessionPath(workspaceRoot, "v2-rich-display", { sessionsRoot })),
    ).resolves.toBeDefined();
    const v3 = await readSessionEvents(workspaceRoot, "v2-rich-display", { sessionsRoot });
    expect(v3.meta.schemaVersion).toBe(3);
    expect(v3.events[1]).toMatchObject({
      type: "user_input_recorded",
      input: {
        version: 1,
        kind: "legacy",
        display: { text: "review @src/a.ts" },
        message: { content: "frozen V2 model input" },
      },
    });

    await fs.writeFile(source.filePath, "{corrupt V2", "utf8");
    await expect(
      loadSession(workspaceRoot, "v2-rich-display", { sessionsRoot }),
    ).resolves.toMatchObject({
      meta: { title: "review @src/a.ts" },
    });
  });

  it("publishes one winning V3 journal when V2 migrations race", async () => {
    const source = await writeV2("v2-race");
    const options = { sessionsRoot, originator: "test", appVersion: "1.0.0" };

    const [first, second] = await Promise.all([
      resumeSession(workspaceRoot, "v2-race", options),
      resumeSession(workspaceRoot, "v2-race", options),
    ]);

    expect(first?.meta.title).toBe("review @src/a.ts");
    expect(second?.meta.title).toBe("review @src/a.ts");
    expect(await fs.readFile(source.filePath, "utf8")).toBe(source.bytes);
    const v3 = await readSessionEvents(workspaceRoot, "v2-race", { sessionsRoot });
    expect(v3.meta.schemaVersion).toBe(3);
    expect(v3.events.filter((event) => event.type === "user_input_recorded")).toHaveLength(1);
  });

  it("refuses to migrate while a real V2 writer owns the source journal", async () => {
    await writeV2("v2-active-writer");
    const v2Path = resolveV2SessionPath(workspaceRoot, "v2-active-writer", { sessionsRoot });
    const lock = await acquireSessionWriterLock(v2Path, "live-v2-writer");
    try {
      await expect(
        resumeSession(workspaceRoot, "v2-active-writer", {
          sessionsRoot,
          originator: "test",
          appVersion: "1.0.0",
        }),
      ).rejects.toMatchObject({ cause: expect.any(SessionWriterLockedError) });
      await expect(
        fs.access(resolveV3SessionPath(workspaceRoot, "v2-active-writer", { sessionsRoot })),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await releaseSessionWriterLock(lock);
    }
  });

  it("moves V2 image metadata into one frozen V3 legacy record", async () => {
    await writeV2Image("v2-image");
    const blobRoot = path.join(tmpDir, "blobs");

    const resumed = await resumeSession(workspaceRoot, "v2-image", {
      sessionsRoot,
      blobRoot,
      originator: "test",
      appVersion: "1.0.0",
    });
    const materialized = await materializeMessageHistory(resumed?.messages ?? [], { blobRoot });
    expect(materialized[0]?.content).toEqual([
      { type: "text", text: "[Image #1]" },
      expect.objectContaining({
        type: "image",
        image: expect.objectContaining({ url: expect.stringMatching(/^data:image\/png;base64,/) }),
      }),
    ]);

    const v3 = await readSessionEvents(workspaceRoot, "v2-image", { sessionsRoot });
    expect(v3.events[1]).toMatchObject({
      type: "user_input_recorded",
      input: {
        kind: "legacy",
        display: { text: "[Image #1]" },
      },
    });
    const migratedInput = v3.events[1];
    expect(
      migratedInput &&
        isKnownSessionEvent(migratedInput) &&
        migratedInput.type === "user_input_recorded" &&
        migratedInput.input.kind === "legacy"
        ? Object.values(migratedInput.input.imageBlobs)
        : [],
    ).toEqual([expect.objectContaining({ blobRef: expect.stringMatching(/^rejelly-blob:\/\//) })]);
    expect(
      migratedInput &&
        isKnownSessionEvent(migratedInput) &&
        migratedInput.type === "user_input_recorded"
        ? migratedInput.input.kind === "legacy"
          ? migratedInput.input.message.extra?.rejelly
          : "wrong input kind"
        : "missing event",
    ).toBeUndefined();
  });

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
    ).rejects.toMatchObject({ kind: "unreadable", format: "v3" });
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
    await recordInitialTextInput(recorder, "turn-1", "v3 wins");
    await recorder.completeTurn("turn-1", "completed");
    await recorder.endSegment({ status: "completed", reason: "exit" });
    await recorder.close();

    const listed = await listSessions(workspaceRoot, { sessionsRoot });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "duplicate",
      title: "v3 wins",
      turns: 1,
      traceIds: ["v2-trace"],
    });
    expect((await loadSession(workspaceRoot, "duplicate", { sessionsRoot }))?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "v3 wins" }),
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

  it("applies a compact event that was flushed before its state checkpoint", async () => {
    const recorder = await openSessionRecorder({
      workspaceRoot,
      sessionId: "compact-suffix",
      traceId: "trace-1",
      originator: "test",
      appVersion: "1.0.0",
      modelId: "test-model",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await recordInitialTextInput(recorder, "turn-1", "retain this transcript");
    await recorder.recordMessage(
      "turn-1",
      { kind: "model" },
      { role: "assistant", content: "large pre-compact response" },
    );
    await recorder.completeTurn("turn-1", "completed");
    await recorder.close();

    const writer = await openSessionWriter(
      createSessionMetaLine({
        sessionId: "compact-suffix",
        workspaceRoot,
        originator: "test",
        appVersion: "1.0.0",
      }),
      { sessionsRoot },
    );
    await writer.append({
      type: "context_compacted",
      trigger: "manual",
      replacementHistory: [{ role: "user", content: "bounded active checkpoint" }],
      beforeMessageCount: 2,
      afterMessageCount: 1,
    });
    await writer.close();

    const stored = await readSessionEvents(workspaceRoot, "compact-suffix", { sessionsRoot });
    expect(stored.events.at(-1)).toMatchObject({ type: "context_compacted" });

    const resumed = await resumeSession(workspaceRoot, "compact-suffix", {
      originator: "test",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(resumed?.messages).toEqual([{ role: "user", content: "bounded active checkpoint" }]);
    expect(
      resumed?.transcript?.flatMap((item) =>
        item.type === "user" || item.type === "assistant" ? [item.content] : [],
      ),
    ).toEqual(["retain this transcript", "large pre-compact response"]);
    await expect(listSessions(workspaceRoot, { sessionsRoot })).resolves.toMatchObject([
      {
        id: "compact-suffix",
        title: "retain this transcript",
        turns: 1,
      },
    ]);
  });

  it("recovers incomplete tool tails without retrying or discarding known results", async () => {
    async function writeIncompleteToolTurn(
      sessionId: string,
      includeResult: boolean,
    ): Promise<void> {
      const recorder = await openSessionRecorder({
        workspaceRoot,
        sessionId,
        traceId: `${sessionId}-trace`,
        originator: "test",
        appVersion: "1.0.0",
        modelId: "test-model",
        cwd: workspaceRoot,
        sessionsRoot,
      });
      await recordInitialTextInput(recorder, "turn-1", "run the side-effecting tool");
      await recorder.recordMessage(
        "turn-1",
        { kind: "model" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", name: "side_effect", arguments: "{}" }],
        },
      );
      if (includeResult) {
        await recorder.recordMessage(
          "turn-1",
          { kind: "tool" },
          {
            role: "tool",
            tool_call_id: "call-1",
            name: "side_effect",
            content: "effect completed",
          },
        );
      }
      await recorder.close();
    }

    await writeIncompleteToolTurn("unknown-outcome", false);
    await writeIncompleteToolTurn("known-outcome", true);

    for (const sessionId of ["unknown-outcome", "known-outcome"]) {
      const recovery = await openSessionRecorder({
        workspaceRoot,
        sessionId,
        traceId: `${sessionId}-recovery-trace`,
        originator: "test",
        appVersion: "1.0.0",
        modelId: "test-model",
        cwd: workspaceRoot,
        sessionsRoot,
      });
      await recovery.endSegment({ status: "completed", reason: "exit" });
      await recovery.close();
    }

    const unknown = await resumeSession(workspaceRoot, "unknown-outcome", {
      originator: "test",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(unknown?.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call-1", name: "side_effect" })],
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-1",
        content: expect.stringContaining("outcome is unknown"),
      }),
    ]);

    const unknownStored = await readSessionEvents(workspaceRoot, "unknown-outcome", {
      sessionsRoot,
    });
    const resumedStart = unknownStored.events.find(
      (event) =>
        event.type === "run_segment_started" && event.traceId === "unknown-outcome-recovery-trace",
    );
    const durableRecovery = unknownStored.events.find(
      (event) =>
        isKnownSessionEvent(event) &&
        event.type === "message_recorded" &&
        event.source.kind === "recovery" &&
        event.turnId === "turn-1",
    );
    const durableClosure = unknownStored.events.find(
      (event) =>
        event.type === "turn_completed" &&
        event.turnId === "turn-1" &&
        event.status === "interrupted",
    );
    expect(durableRecovery).toMatchObject({
      message: {
        role: "tool",
        tool_call_id: "call-1",
        content: expect.stringContaining("outcome is unknown"),
      },
    });
    expect(durableRecovery?.seq).toBeGreaterThan(resumedStart?.seq ?? Number.POSITIVE_INFINITY);
    expect(durableClosure?.seq).toBeGreaterThan(durableRecovery?.seq ?? Number.POSITIVE_INFINITY);

    const known = await resumeSession(workspaceRoot, "known-outcome", {
      originator: "test",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(known?.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-1",
        content: "effect completed",
      }),
    ]);
    const knownStored = await readSessionEvents(workspaceRoot, "known-outcome", { sessionsRoot });
    expect(
      knownStored.events.filter(
        (event) =>
          isKnownSessionEvent(event) &&
          event.type === "message_recorded" &&
          event.source.kind === "recovery",
      ),
    ).toHaveLength(0);
    expect(knownStored.events).toContainEqual(
      expect.objectContaining({
        type: "turn_completed",
        turnId: "turn-1",
        status: "interrupted",
      }),
    );
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
    const filePath = resolveV3SessionPath(workspaceRoot, "idle-abort", { sessionsRoot });
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
