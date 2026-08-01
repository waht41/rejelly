import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { createMockModel } from "@rejelly/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKnownSessionEvent } from "../../../services/session/sessionEvents";
import {
  readSessionEvents,
  resolveV2SessionPath,
} from "../../../services/session/sessionJsonlStore";
import { openSessionRecorder } from "../../../services/session/sessionRecorder";
import { resumeSession } from "../../../services/session/sessionStore";
import { setWorkspaceRoot } from "../../../shared/fs-policy/workspace-fs-policy";
import { isCompactionBridgeMessage } from "../../../shared/lib/compactionMessages";
import { messageContentToText } from "../../../shared/lib/tokens";
import type { TranscriptItem } from "../../../shared/transcript";
import type { EvilJellyHostBindings } from "../../../shared/types";
import { runEvilJellyHost } from "./runHost";

const originalAutoCompactTokens = process.env.OPENAI_AUTO_COMPACT_TOKENS;
const originalAutoCompactRatio = process.env.OPENAI_AUTO_COMPACT_RATIO;
const originalContextWindow = process.env.OPENAI_CONTEXT_WINDOW;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

type MemoryInput = Awaited<ReturnType<EvilJellyHostBindings["getInput"]>>;

function createMemoryBindings(inputs: Array<string | MemoryInput>): EvilJellyHostBindings {
  const queue = [...inputs];
  return {
    getInput: async () => {
      const input = queue.shift() ?? "/exit";
      return typeof input === "string" ? { text: input, attachments: [] } : input;
    },
    printOut: () => undefined,
    logUserMessage: () => undefined,
    logAssistantMessage: () => undefined,
    logSystemEvent: () => undefined,
    logToolBlock: () => undefined,
    confirmTool: async () => ({ action: "accept" }),
    requestChoice: async (_message, options) => options[0]?.value ?? "",
    getAgentMode: () => "auto",
  };
}

describe("non-TTY session lifecycle", () => {
  let tmpDir: string;
  let sessionsRoot: string;
  let blobRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-lifecycle-"));
    sessionsRoot = path.join(tmpDir, "sessions");
    blobRoot = path.join(tmpDir, "blobs");
    workspaceRoot = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "fixture workspace\n", "utf8");
    setWorkspaceRoot(workspaceRoot);
    delete process.env.OPENAI_AUTO_COMPACT_TOKENS;
    delete process.env.OPENAI_AUTO_COMPACT_RATIO;
    delete process.env.OPENAI_CONTEXT_WINDOW;
  });

  afterEach(async () => {
    restoreEnv("OPENAI_AUTO_COMPACT_TOKENS", originalAutoCompactTokens);
    restoreEnv("OPENAI_AUTO_COMPACT_RATIO", originalAutoCompactRatio);
    restoreEnv("OPENAI_CONTEXT_WINDOW", originalContextWindow);
    setWorkspaceRoot(process.cwd());
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    { name: "exits immediately", inputs: ["/exit"] },
    { name: "only checks status", inputs: ["/status", "/exit"] },
  ])("does not create an empty session when it $name", async ({ inputs }) => {
    const model = createMockModel();
    await runEvilJellyHost(createMemoryBindings(inputs), {
      model: model.adapter,
      sessionId: "untouched",
      sessionStartMode: "new",
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot },
    });

    expect(model.calls.count()).toBe(0);
    await expect(
      fs.access(resolveV2SessionPath(workspaceRoot, "untouched", { sessionsRoot })),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a tool turn, manual compaction, resume, and a continued turn", async () => {
    const firstModel = createMockModel();
    firstModel.sequence([
      {
        type: "tool_calls",
        calls: [
          {
            id: "list-call",
            name: "list_directory",
            arguments: { dirPath: ".", depth: 1 },
          },
        ],
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          details: { cacheReadTokens: 1 },
        },
      },
      {
        type: "text",
        content: "The workspace contains a README.",
        usage: {
          promptTokens: 15,
          completionTokens: 3,
          totalTokens: 18,
          details: { cacheReadTokens: 2 },
        },
      },
      {
        type: "text",
        content: "Inspected the workspace and found README.md.",
        usage: {
          promptTokens: 20,
          completionTokens: 4,
          totalTokens: 24,
          details: { cacheReadTokens: 3 },
        },
      },
    ]);

    await runEvilJellyHost(createMemoryBindings(["Inspect the workspace", "/compress", "/exit"]), {
      model: firstModel.adapter,
      sessionId: "lifecycle",
      sessionStartMode: "new",
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot },
    });

    const firstResume = await resumeSession(workspaceRoot, "lifecycle", {
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(firstResume).toBeDefined();

    const secondModel = createMockModel();
    secondModel.sequence([
      {
        type: "text",
        content: "The resumed session continued successfully.",
        usage: {
          promptTokens: 30,
          completionTokens: 5,
          totalTokens: 35,
          details: { cacheReadTokens: 4 },
        },
      },
    ]);

    await runEvilJellyHost(createMemoryBindings(["Continue from the inspection", "/exit"]), {
      model: secondModel.adapter,
      sessionId: "lifecycle",
      sessionStartMode: "resumed",
      seedContext: firstResume?.messages,
      seedBudget: firstResume?.meta.budget,
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot },
    });

    const finalResume = await resumeSession(workspaceRoot, "lifecycle", {
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(finalResume?.meta).toMatchObject({
      id: "lifecycle",
      title: "Inspect the workspace",
      turns: 2,
      budget: {
        totalTokens: 89,
        promptTokens: 75,
        completionTokens: 14,
        cacheReadTokens: 10,
        callCount: 4,
        lastContextTokens: 30,
        lastCacheReadTokens: 4,
      },
    });

    const transcript = finalResume?.transcript ?? [];
    expect(
      transcript.flatMap((item) =>
        item.type === "user" && item.inputKind === "initial" ? [item.content] : [],
      ),
    ).toEqual(["Inspect the workspace", "Continue from the inspection"]);
    expect(transcript).toContainEqual(
      expect.objectContaining({
        type: "tool",
        toolCallId: "list-call",
        toolName: "list_directory",
        ok: true,
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        content: "The resumed session continued successfully.",
      }),
    );
    expect(
      transcript.some(
        (item) =>
          "content" in item && item.content.includes("Inspected the workspace and found README"),
      ),
    ).toBe(false);

    expect(
      secondModel.calls
        .first()
        ?.messages.some(
          (message) =>
            message.content !== null &&
            messageContentToText(message.content).includes(
              "Inspected the workspace and found README.md.",
            ),
        ),
    ).toBe(true);

    const stored = await readSessionEvents(workspaceRoot, "lifecycle", { sessionsRoot });
    expect(stored.meta).toMatchObject({ type: "session_meta", sessionId: "lifecycle" });
    expect(stored.events.slice(0, 2)).toMatchObject([
      { type: "run_segment_started", kind: "created" },
      {
        type: "message_recorded",
        source: { kind: "user_input", inputKind: "initial" },
      },
    ]);
    const starts = stored.events.filter((event) => event.type === "run_segment_started");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((event) => event.traceId))).toHaveLength(2);
    expect(stored.events.filter((event) => event.type === "run_segment_ended")).toHaveLength(2);
    expect(stored.events.filter((event) => event.type === "turn_completed")).toHaveLength(2);
    expect(stored.events.filter((event) => event.type === "context_compacted")).toMatchObject([
      { trigger: "manual" },
    ]);
  });

  it("auto-compacts inside a tool turn while preserving its transcript across resume", async () => {
    process.env.OPENAI_AUTO_COMPACT_TOKENS = "1";
    const model = createMockModel();
    model.sequence([
      {
        type: "tool_calls",
        calls: [
          {
            id: "list-call-1",
            name: "list_directory",
            arguments: { dirPath: ".", depth: 1 },
          },
          {
            id: "list-call-2",
            name: "list_directory",
            arguments: { dirPath: ".", depth: 1 },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      },
      {
        type: "text",
        content: "Both directory checks found README.md; continue with the live request.",
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
      },
      {
        type: "text",
        content: "Both workspace checks completed after automatic compaction.",
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      },
    ]);

    await runEvilJellyHost(createMemoryBindings(["Check the workspace twice", "/exit"]), {
      model: model.adapter,
      sessionId: "auto-compact",
      sessionStartMode: "new",
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot },
    });

    const resumed = await resumeSession(workspaceRoot, "auto-compact", {
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(resumed?.meta).toMatchObject({
      title: "Check the workspace twice",
      turns: 1,
      budget: {
        totalTokens: 51,
        promptTokens: 42,
        completionTokens: 9,
        callCount: 3,
        lastContextTokens: 12,
      },
    });

    const activeContext = resumed?.messages ?? [];
    expect(activeContext.some(isCompactionBridgeMessage)).toBe(true);
    expect(activeContext.some((message) => message.role === "tool")).toBe(false);
    expect(
      activeContext.some(
        (message) =>
          message.role === "assistant" &&
          message.content !== null &&
          messageContentToText(message.content) ===
            "Both workspace checks completed after automatic compaction.",
      ),
    ).toBe(true);

    const transcript = resumed?.transcript ?? [];
    expect(
      transcript.filter((item) => item.type === "tool").map((item) => item.toolCallId),
    ).toEqual(["list-call-1", "list-call-2"]);
    expect(transcript).toContainEqual(
      expect.objectContaining({
        type: "assistant",
        content: "Both workspace checks completed after automatic compaction.",
      }),
    );
    expect(
      transcript.some(
        (item) =>
          "content" in item &&
          item.content.includes("Both directory checks found README.md; continue"),
      ),
    ).toBe(false);

    const stored = await readSessionEvents(workspaceRoot, "auto-compact", { sessionsRoot });
    const compact = stored.events.find(
      (event) => isKnownSessionEvent(event) && event.type === "context_compacted",
    );
    const initialUser = stored.events.find(
      (event) =>
        isKnownSessionEvent(event) &&
        event.type === "message_recorded" &&
        event.source.kind === "user_input" &&
        event.source.inputKind === "initial",
    );
    const completed = stored.events.find(
      (event) => isKnownSessionEvent(event) && event.type === "turn_completed",
    );
    expect(compact).toMatchObject({
      trigger: "auto",
      activeTurnId: initialUser?.turnId,
    });
    expect(completed?.turnId).toBe(initialUser?.turnId);
    expect(compact?.seq).toBeLessThan(completed?.seq ?? 0);
  });

  it("does not automatically rerun a user-only turn recovered from a crashed segment", async () => {
    const crashed = await openSessionRecorder({
      workspaceRoot,
      sessionId: "user-only-crash",
      traceId: "crashed-trace",
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      modelId: "test-model",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await crashed.recordMessage(
      "incomplete-turn",
      { kind: "user_input", inputKind: "initial" },
      { role: "user", content: "do not replay this automatically" },
    );
    await crashed.close();

    const seed = await resumeSession(workspaceRoot, "user-only-crash", {
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      sessionsRoot,
    });
    expect(seed?.messages).toEqual([{ role: "user", content: "do not replay this automatically" }]);

    const model = createMockModel();
    await runEvilJellyHost(createMemoryBindings(["/exit"]), {
      model: model.adapter,
      sessionId: "user-only-crash",
      sessionStartMode: "resumed",
      seedContext: seed?.messages,
      seedBudget: seed?.meta.budget,
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot },
    });

    expect(model.calls.count()).toBe(0);
    const stored = await readSessionEvents(workspaceRoot, "user-only-crash", { sessionsRoot });
    const starts = stored.events.filter(
      (event) => isKnownSessionEvent(event) && event.type === "run_segment_started",
    );
    const recoveredTurn = stored.events.find(
      (event) =>
        isKnownSessionEvent(event) &&
        event.type === "turn_completed" &&
        event.turnId === "incomplete-turn",
    );
    const ended = stored.events.filter(
      (event) => isKnownSessionEvent(event) && event.type === "run_segment_ended",
    );
    expect(starts).toHaveLength(2);
    expect(recoveredTurn).toMatchObject({ status: "interrupted" });
    expect(recoveredTurn?.seq).toBeGreaterThan(starts[1]?.seq ?? Number.POSITIVE_INFINITY);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.seq).toBeGreaterThan(recoveredTurn?.seq ?? Number.POSITIVE_INFINITY);
  });

  it("resumes copied image blobs after source deletion and preserves them through compaction", async () => {
    process.env.OPENAI_CONTEXT_WINDOW = "50000";
    const imageBytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(imageBytes);
    imageBytes.write("IHDR", 12, "ascii");
    imageBytes.writeUInt32BE(4096, 16);
    imageBytes.writeUInt32BE(4096, 20);
    const sourcePaths = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const sourcePath = path.join(tmpDir, `clipboard-${index}.png`);
        await fs.writeFile(sourcePath, imageBytes);
        return sourcePath;
      }),
    );

    const firstModel = createMockModel();
    firstModel.sequence([
      {
        type: "text",
        content: "I inspected the attached images.",
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
      },
    ]);
    await runEvilJellyHost(
      createMemoryBindings([
        {
          text: "Compare these screenshots",
          attachments: sourcePaths.map((sourcePath) => ({
            type: "image" as const,
            path: sourcePath,
            mimeType: "image/png" as const,
            detail: "auto" as const,
          })),
        },
        "/exit",
      ]),
      {
        model: firstModel.adapter,
        sessionId: "image-lifecycle",
        sessionStartMode: "new",
        sessionV2: {
          enabled: true,
          appVersion: "1.0.0",
          sessionsRoot,
          blobRoot,
        },
      },
    );
    await Promise.all(sourcePaths.map((sourcePath) => fs.unlink(sourcePath)));

    const firstResume = await resumeSession(workspaceRoot, "image-lifecycle", {
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      sessionsRoot,
      blobRoot,
    });
    expect(firstResume).toBeDefined();
    expect(imageUrls(firstResume?.messages ?? [])).toHaveLength(5);
    expect(
      imageUrls(firstResume?.messages ?? []).every((url) => url.startsWith("rejelly-blob://")),
    ).toBe(true);
    const firstTranscriptUser = firstResume?.transcript?.find(
      (item) => item.type === "user" && item.inputKind === "initial",
    );
    expect(firstTranscriptUser).toMatchObject({
      type: "user",
      content: "Compare these screenshots",
      images: [
        { blobRef: expect.stringMatching(/^rejelly-blob:\/\/[a-f0-9]{64}$/) },
        { blobRef: expect.stringMatching(/^rejelly-blob:\/\/[a-f0-9]{64}$/) },
        { blobRef: expect.stringMatching(/^rejelly-blob:\/\/[a-f0-9]{64}$/) },
        { blobRef: expect.stringMatching(/^rejelly-blob:\/\/[a-f0-9]{64}$/) },
        { blobRef: expect.stringMatching(/^rejelly-blob:\/\/[a-f0-9]{64}$/) },
      ],
    });

    const compactModel = createMockModel();
    compactModel.sequence([
      {
        type: "text",
        content: "The image comparison can continue without the temporary files.",
        usage: { promptTokens: 25, completionTokens: 5, totalTokens: 30 },
      },
      {
        type: "text",
        content: "The user asked to compare five screenshots.",
        usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
      },
    ]);
    await runEvilJellyHost(
      createMemoryBindings(["Continue the comparison", "/compress", "/exit"]),
      {
        model: compactModel.adapter,
        sessionId: "image-lifecycle",
        sessionStartMode: "resumed",
        seedContext: firstResume?.messages,
        seedBudget: firstResume?.meta.budget,
        sessionV2: {
          enabled: true,
          appVersion: "1.0.0",
          sessionsRoot,
          blobRoot,
        },
      },
    );
    expect(compactModel.calls.count()).toBe(2);
    for (const call of compactModel.calls.all()) {
      expect(imageUrls(call.messages)).toHaveLength(5);
      expect(imageUrls(call.messages).every((url) => url.startsWith("data:image/"))).toBe(true);
    }

    const finalResume = await resumeSession(workspaceRoot, "image-lifecycle", {
      originator: "evil-jelly-cli",
      appVersion: "1.0.0",
      sessionsRoot,
      blobRoot,
    });
    const compactedImages = imageUrls(finalResume?.messages ?? []);
    expect(compactedImages.length).toBeGreaterThan(0);
    expect(compactedImages.length).toBeLessThan(5);
    expect(compactedImages.every((url) => url.startsWith("rejelly-blob://"))).toBe(true);
    const finalTranscriptUser = finalResume?.transcript?.find(
      (item): item is Extract<TranscriptItem, { type: "user" | "assistant" }> =>
        item.type === "user" && item.inputKind === "initial",
    );
    expect(finalTranscriptUser?.images).toHaveLength(5);

    const stored = await readSessionEvents(workspaceRoot, "image-lifecycle", { sessionsRoot });
    const initialUser = stored.events.find(
      (event) =>
        isKnownSessionEvent(event) &&
        event.type === "message_recorded" &&
        event.source.kind === "user_input" &&
        event.source.inputKind === "initial",
    );
    const compact = stored.events.find(
      (event) => isKnownSessionEvent(event) && event.type === "context_compacted",
    );
    const compactHistory =
      compact && isKnownSessionEvent(compact) && compact.type === "context_compacted"
        ? compact.replacementHistory
        : [];
    const initialUserMessage: Message | undefined =
      initialUser && isKnownSessionEvent(initialUser) && initialUser.type === "message_recorded"
        ? initialUser.message
        : undefined;
    expect(imageUrls(initialUserMessage ? [initialUserMessage] : [])).toHaveLength(5);
    expect(imageUrls(compactHistory).length).toBeLessThan(5);
    expect(imageUrls(compactHistory).every((url) => url.startsWith("rejelly-blob://"))).toBe(true);
    const blobs = await fs.readdir(blobRoot);
    expect(blobs).toHaveLength(1);
    await expect(fs.readFile(path.join(blobRoot, blobs[0]!))).resolves.toEqual(imageBytes);
    const rawSession = await fs.readFile(
      resolveV2SessionPath(workspaceRoot, "image-lifecycle", { sessionsRoot }),
      "utf8",
    );
    expect(rawSession).toContain("rejelly-blob://");
    expect(rawSession).not.toContain("data:image/");
  });
});

function imageUrls(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === "image" ? [part.image.url] : []))
      : [],
  );
}
