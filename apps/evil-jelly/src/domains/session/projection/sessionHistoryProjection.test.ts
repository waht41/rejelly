import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistMessageImageBlobs } from "../journal/sessionBlobStore";
import type { MessageRecordedEvent, SessionEvent } from "../model/sessionEvents";
import { parseStoredSessionMessage } from "../model/storedSessionMessage";
import { materializeActiveContext } from "../repository/sessionMessageMaterializer";
import {
  buildContextTokenAnchor,
  buildLatestBudget,
  buildStoredActiveContext,
  buildTranscript,
} from "./sessionHistoryProjection";
import { type PreparedSessionReplay, prepareSessionReplay } from "./sessionReplay";

function event(
  value: {
    type: "message_recorded";
    turnId: string;
    source: MessageRecordedEvent["source"];
    message: Message;
  },
  seq: number,
): SessionEvent {
  return { ...value, seq, timestamp: 100 + seq } as MessageRecordedEvent;
}

function replay(events: SessionEvent[]): PreparedSessionReplay {
  return prepareSessionReplay(events);
}

function transcriptContent(events: SessionEvent[]): string[] {
  return buildTranscript(replay(events)).flatMap((item) =>
    "content" in item ? [item.content] : [],
  );
}

function userEvent(
  seq: number,
  turnId: string,
  content: Message["content"],
  inputKind: "initial" | "steer" = "initial",
  extra?: Message["extra"],
): SessionEvent {
  return event(
    {
      type: "message_recorded",
      turnId,
      source: { kind: "user_input", inputKind },
      message: { role: "user", content, extra },
    },
    seq,
  );
}

describe("session history projections", () => {
  let tmpDir: string;
  let blobRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-projection-"));
    blobRoot = path.join(tmpDir, "blobs");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps the full transcript while compaction replaces only active context", () => {
    const events: SessionEvent[] = [
      userEvent(1, "turn-1", "old question"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: { role: "assistant", content: '{"reply":"old answer"}' },
        },
        2,
      ),
      {
        type: "turn_completed",
        seq: 3,
        timestamp: 103,
        turnId: "turn-1",
        status: "completed",
      },
      {
        type: "context_compacted",
        seq: 4,
        timestamp: 104,
        trigger: "manual",
        replacementHistory: [
          {
            role: "user",
            content: "[Context was automatically compacted]\nprivate model summary",
            extra: { rejelly: { kind: "compaction_bridge" } },
          },
        ],
        beforeMessageCount: 2,
        afterMessageCount: 1,
      },
      userEvent(5, "turn-2", "new question"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-2",
          source: { kind: "model" },
          message: { role: "assistant", content: "new answer" },
        },
        6,
      ),
      {
        type: "turn_completed",
        seq: 7,
        timestamp: 107,
        turnId: "turn-2",
        status: "completed",
      },
    ];

    expect(transcriptContent(events)).toEqual([
      "old question",
      "old answer",
      "new question",
      "new answer",
    ]);
    expect(
      buildTranscript(replay(events), { tailTurns: 1 }).flatMap((item) =>
        "content" in item ? [item.content] : [],
      ),
    ).toEqual(["new question", "new answer"]);
    expect(buildTranscript(replay(events), { includeCompactionBoundaries: true })).toContainEqual(
      expect.objectContaining({ type: "system", kind: "compaction" }),
    );
    expect(buildStoredActiveContext(replay(events)).map((message) => message.content)).toEqual([
      "[Context was automatically compacted]\nprivate model summary",
      "new question",
      "new answer",
    ]);
  });

  it("pairs tool calls with results and marks interrupted turns without exposing internals", () => {
    const events: SessionEvent[] = [
      userEvent(1, "turn-1", "inspect"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }],
          },
        },
        2,
      ),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "tool" },
          message: { role: "tool", tool_call_id: "call-1", content: "file body" },
        },
        3,
      ),
      {
        type: "turn_completed",
        seq: 4,
        timestamp: 104,
        turnId: "turn-1",
        status: "interrupted",
      },
      {
        type: "budget_updated",
        seq: 5,
        timestamp: 105,
        budget: {
          totalTokens: 3,
          promptTokens: 2,
          completionTokens: 1,
          cacheReadTokens: 0,
          callCount: 1,
          costs: {},
          lastContextTokens: 2,
          lastCacheReadTokens: 0,
        },
      },
    ];

    expect(buildTranscript(replay(events))).toEqual([
      expect.objectContaining({ type: "user", content: "inspect" }),
      expect.objectContaining({
        type: "tool",
        toolName: "read_file",
        arguments: '{"path":"a.ts"}',
        result: "file body",
        ok: true,
      }),
      expect.objectContaining({ type: "system", kind: "interrupted" }),
    ]);
  });

  it("heads a multi-call assistant message so a resumed batch reads as one", () => {
    // Derived from tool_calls.length, not stored: the batch is already recorded as that array,
    // so the live view and a resumed transcript group identically without a new event type.
    const events: SessionEvent[] = [
      userEvent(1, "turn-1", "check both"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
              { id: "call-2", name: "grep", arguments: '{"pattern":"x"}' },
            ],
          },
        },
        2,
      ),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "tool" },
          message: { role: "tool", tool_call_id: "call-1", content: "file body" },
        },
        3,
      ),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "tool" },
          message: { role: "tool", tool_call_id: "call-2", content: "match" },
        },
        4,
      ),
    ];

    expect(buildTranscript(replay(events)).map((item) => item.type)).toEqual([
      "user",
      "tool_round",
      "tool",
      "tool",
    ]);
    expect(buildTranscript(replay(events))).toContainEqual(
      expect.objectContaining({ type: "tool_round", calls: 2, turnId: "turn-1" }),
    );
  });

  it("merges durable observation metadata into its canonical tool call", () => {
    const events: SessionEvent[] = [
      userEvent(1, "turn-1", "edit it"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", name: "edit_file", arguments: '{"path":"a.ts"}' }],
          },
        },
        2,
      ),
      {
        type: "tool_observation_recorded",
        seq: 3,
        timestamp: 103,
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "edit_file",
        summary: "[Tools] edit_file → a.ts",
        detail: {
          type: "diff",
          text: "@@ -1 +1 @@\n-old\n+new",
          phase: "applied",
          presentation: "inline",
        },
        ok: false,
      },
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "tool" },
          message: { role: "tool", tool_call_id: "call-1", content: "updated" },
        },
        4,
      ),
    ];

    expect(buildTranscript(replay(events))).toContainEqual(
      expect.objectContaining({
        type: "tool",
        toolCallId: "call-1",
        summary: "[Tools] edit_file → a.ts",
        detail: expect.objectContaining({ type: "diff", phase: "applied" }),
        result: "updated",
        ok: false,
      }),
    );
  });

  it("leaves a single tool call unheaded, since one block is its own batch", () => {
    const events: SessionEvent[] = [
      userEvent(1, "turn-1", "check one"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
          },
        },
        2,
      ),
    ];

    expect(buildTranscript(replay(events)).map((item) => item.type)).toEqual(["user", "tool"]);
  });

  it("closes a dangling tool call in an incomplete tail without retrying it", () => {
    const events: SessionEvent[] = [
      userEvent(1, "turn-1", "run tool"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", name: "dangerous_tool", arguments: "{}" }],
          },
        },
        2,
      ),
      {
        type: "turn_completed",
        seq: 3,
        timestamp: 103,
        turnId: "turn-1",
        status: "interrupted",
      },
    ];

    expect(buildStoredActiveContext(replay(events))).toEqual([
      expect.objectContaining({ role: "user", content: "run tool" }),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-1",
        content: expect.stringContaining("outcome is unknown"),
      }),
    ]);
  });

  it("uses structured attachment display while leaving legacy text untouched", () => {
    const events: SessionEvent[] = [
      userEvent(
        1,
        "turn-1",
        [
          {
            type: "text",
            text: '<attached_file path="secret.txt">private body</attached_file>',
          },
        ],
        "initial",
        {
          rejelly: {
            kind: "user_input",
            display: {
              text: "inspect this",
              attachments: [{ type: "file", label: "secret.txt", action: "read" }],
            },
          },
        },
      ),
      {
        type: "legacy_snapshot",
        seq: 2,
        timestamp: 102,
        sourceSchemaVersion: 1,
        importedAt: 102,
        legacyMeta: {
          id: "legacy",
          workspaceRoot: "/work",
          title: "legacy",
          createdAt: 1,
          updatedAt: 2,
          turns: 1,
          traceIds: [],
        },
        messages: [{ role: "user", content: "## Attached files\nthis is real user text" }],
      },
    ];

    expect(transcriptContent(events)).toEqual([
      "inspect this",
      "## Attached files\nthis is real user text",
    ]);
    expect(buildTranscript(replay(events))[0]).toMatchObject({
      type: "user",
      content: "inspect this",
      attachments: [{ type: "file", label: "secret.txt", action: "read" }],
    });
  });

  it("validates stored image invariants and materializes only referenced blobs", async () => {
    const inline = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    const stored = await persistMessageImageBlobs(
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: { url: inline, detail: "low" } },
        ],
      },
      { blobRoot },
    );
    const parsed = parseStoredSessionMessage(stored);
    const transcript = buildTranscript(
      replay([userEvent(1, "turn-1", stored.content, "initial", stored.extra)]),
    );

    await expect(materializeActiveContext([parsed], { blobRoot })).resolves.toMatchObject([
      {
        content: [
          { type: "text", text: "look" },
          { type: "image", image: { url: inline, detail: "low" } },
        ],
      },
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({
        type: "user",
        content: "look",
        images: [expect.objectContaining({ blobRef: expect.stringMatching(/^rejelly-blob:\/\//) })],
      }),
    ]);
    expect(JSON.stringify(transcript)).not.toContain("data:image");
    expect(() =>
      parseStoredSessionMessage({
        role: "user",
        content: [{ type: "image", image: { url: inline } }],
      }),
    ).toThrow("cannot contain inline image");
    expect(() =>
      parseStoredSessionMessage({
        ...stored,
        extra: { rejelly: { imageBlobs: {} } },
      }),
    ).toThrow("Missing metadata");
  });

  it("selects the latest cumulative budget without treating compaction as usage", () => {
    const first = {
      totalTokens: 10,
      promptTokens: 8,
      completionTokens: 2,
      cacheReadTokens: 0,
      callCount: 1,
      costs: {},
      lastContextTokens: 8,
      lastCacheReadTokens: 0,
    };
    const second = { ...first, totalTokens: 20, callCount: 2 };
    const events: SessionEvent[] = [
      { type: "budget_updated", seq: 1, timestamp: 101, budget: first },
      {
        type: "context_compacted",
        seq: 2,
        timestamp: 102,
        trigger: "manual",
        replacementHistory: [],
        beforeMessageCount: 2,
        afterMessageCount: 0,
      },
      { type: "budget_updated", seq: 3, timestamp: 103, budget: second },
    ];

    expect(buildLatestBudget(replay(events))).toEqual(second);
  });

  it("associates provider prompt usage with the active prefix before the latest model message", () => {
    const budget = {
      totalTokens: 120,
      promptTokens: 100,
      completionTokens: 20,
      cacheReadTokens: 0,
      callCount: 1,
      costs: {},
      lastContextTokens: 100,
      lastCacheReadTokens: 0,
    };
    const events: SessionEvent[] = [
      {
        type: "run_segment_started",
        seq: 1,
        timestamp: 101,
        kind: "created",
        traceId: "trace-1",
        provider: "openai",
        modelId: "model-1",
        cwd: "C:/workspace",
      },
      userEvent(2, "turn-1", "task"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: { role: "assistant", content: "done" },
        },
        3,
      ),
      { type: "budget_updated", seq: 4, timestamp: 104, budget },
    ];

    expect(buildContextTokenAnchor(replay(events))).toEqual({
      promptTokens: 100,
      messageCount: 1,
      modelId: "model-1",
      provider: "openai",
    });
  });

  it("invalidates a provider token anchor across compaction until a later model usage is durable", () => {
    const budget = {
      totalTokens: 120,
      promptTokens: 100,
      completionTokens: 20,
      cacheReadTokens: 0,
      callCount: 1,
      costs: {},
      lastContextTokens: 100,
      lastCacheReadTokens: 0,
    };
    const beforeCompact: SessionEvent[] = [
      {
        type: "run_segment_started",
        seq: 1,
        timestamp: 101,
        kind: "created",
        traceId: "trace-1",
        modelId: "model-1",
        cwd: "C:/workspace",
      },
      userEvent(2, "turn-1", "task"),
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: { role: "assistant", content: "working" },
        },
        3,
      ),
      { type: "budget_updated", seq: 4, timestamp: 104, budget },
      {
        type: "context_compacted",
        seq: 5,
        timestamp: 105,
        trigger: "auto",
        activeTurnId: "turn-1",
        replacementHistory: [{ role: "user", content: "summary" }],
        beforeMessageCount: 2,
        afterMessageCount: 1,
      },
    ];

    expect(buildContextTokenAnchor(replay(beforeCompact))).toBeUndefined();

    const afterCompact: SessionEvent[] = [
      ...beforeCompact,
      event(
        {
          type: "message_recorded",
          turnId: "turn-1",
          source: { kind: "model" },
          message: { role: "assistant", content: "done" },
        },
        6,
      ),
      {
        type: "budget_updated",
        seq: 7,
        timestamp: 107,
        budget: { ...budget, lastContextTokens: 30, callCount: 3 },
      },
    ];
    expect(buildContextTokenAnchor(replay(afterCompact))).toMatchObject({
      promptTokens: 30,
      messageCount: 1,
    });
  });
});
