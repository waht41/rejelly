import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "./sessionEvents";
import { projectSessionSummary, projectSessionSummaryFromState } from "./sessionProjection";
import { prepareSessionReplay } from "./sessionReplay";

const meta: SessionMetaLine = {
  type: "session_meta",
  schemaVersion: 2,
  sessionId: "session-1",
  workspaceRoot: "/work",
  createdAt: 100,
  originator: "evil-jelly",
  appVersion: "0.1.0",
};

describe("sessionProjection", () => {
  it("projects title, turns, traces, budget, and status from events", () => {
    const events: SessionEvent[] = [
      {
        type: "run_segment_started",
        seq: 1,
        timestamp: 101,
        traceId: "trace-1",
        kind: "created",
        modelId: "model",
        cwd: "/work",
      },
      {
        type: "message_recorded",
        seq: 2,
        timestamp: 102,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "initial" },
        message: {
          role: "user",
          content: "raw body",
          extra: {
            rejelly: {
              kind: "user_input",
              display: { text: "A useful session title", attachments: [] },
            },
          },
        },
      },
      {
        type: "message_recorded",
        seq: 3,
        timestamp: 103,
        turnId: "turn-1",
        source: { kind: "model" },
        message: { role: "assistant", content: "done" },
      },
      {
        type: "budget_updated",
        seq: 4,
        timestamp: 104,
        budget: {
          totalTokens: 10,
          promptTokens: 8,
          completionTokens: 2,
          cacheReadTokens: 0,
          callCount: 1,
          costs: {},
          lastContextTokens: 8,
          lastCacheReadTokens: 0,
        },
      },
      {
        type: "turn_completed",
        seq: 5,
        timestamp: 105,
        turnId: "turn-1",
        status: "completed",
      },
      {
        type: "run_segment_ended",
        seq: 6,
        timestamp: 106,
        traceId: "trace-1",
        status: "completed",
        reason: "exit",
      },
    ];

    expect(
      projectSessionSummary(meta, prepareSessionReplay(events), { mtimeMs: 999 }),
    ).toMatchObject({
      id: "session-1",
      title: "A useful session title",
      updatedAt: 999,
      userTurns: 1,
      traceIds: ["trace-1"],
      status: "idle",
      lastSeq: 6,
      budget: { totalTokens: 10 },
    });
  });

  it("counts initial requests but not steers, view_image results, or compaction", () => {
    const events: SessionEvent[] = [
      {
        type: "message_recorded",
        seq: 1,
        timestamp: 101,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "initial" },
        message: { role: "user", content: "Inspect this repository." },
      },
      {
        type: "message_recorded",
        seq: 2,
        timestamp: 102,
        turnId: "turn-1",
        source: { kind: "user_input", inputKind: "steer" },
        message: { role: "user", content: "Also run the tests." },
      },
      {
        type: "message_recorded",
        seq: 3,
        timestamp: 103,
        turnId: "turn-1",
        source: { kind: "tool" },
        message: {
          role: "tool",
          tool_call_id: "view-image-1",
          content: [{ type: "image", image: { url: "https://example.test/image.png" } }],
        },
      },
      {
        type: "context_compacted",
        seq: 4,
        timestamp: 104,
        trigger: "auto",
        activeTurnId: "turn-1",
        replacementHistory: [],
        beforeMessageCount: 3,
        afterMessageCount: 0,
      },
      {
        type: "message_recorded",
        seq: 5,
        timestamp: 105,
        turnId: "turn-2",
        source: { kind: "user_input", inputKind: "initial" },
        message: { role: "user", content: "Now fix the issue." },
      },
    ];

    expect(projectSessionSummary(meta, prepareSessionReplay(events))).toMatchObject({
      title: "Inspect this repository.",
      userTurns: 2,
    });
  });

  it("projects a bounded fast-path summary from state", () => {
    expect(
      projectSessionSummaryFromState(
        meta,
        {
          type: "session_state",
          seq: 20,
          timestamp: 200,
          coveredThroughSeq: 19,
          userTurns: 7,
          title: "checkpoint title",
          traceIds: ["trace-1", "trace-2"],
          status: "interrupted",
        },
        { mtimeMs: 300 },
      ),
    ).toMatchObject({
      title: "checkpoint title",
      updatedAt: 300,
      userTurns: 7,
      traceIds: ["trace-1", "trace-2"],
      status: "interrupted",
      lastSeq: 20,
    });
  });
});
