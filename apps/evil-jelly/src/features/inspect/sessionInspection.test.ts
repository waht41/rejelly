import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "../../domains/session/model/sessionEvents";
import { renderSessionInspection } from "./renderSessionInspection";
import { projectSessionInspection } from "./sessionInspection";

const meta: SessionMetaLine = {
  type: "session_meta",
  schemaVersion: 3,
  sessionId: "session-1",
  workspaceRoot: "C:\\workspace",
  createdAt: 1,
  originator: "test",
  appVersion: "0.2.0",
};

function event(value: Omit<SessionEvent, "seq" | "timestamp">, seq: number): SessionEvent {
  return { ...value, seq, timestamp: seq * 10 } as SessionEvent;
}

describe("projectSessionInspection", () => {
  it("projects session and turn usage without confusing transport and business outcomes", () => {
    const inspection = projectSessionInspection(meta, [
      event(
        {
          type: "run_segment_started",
          kind: "created",
          traceId: "trace",
          modelId: "m",
          cwd: "C:\\workspace",
        },
        1,
      ),
      event(
        {
          type: "user_input_recorded",
          turnId: "turn-1",
          inputKind: "initial",
          input: {
            version: 1,
            nodes: [{ type: "text", text: "hello" }],
            attachments: [],
          },
        },
        2,
      ),
      event(
        {
          type: "model_call_completed",
          turnId: "turn-1",
          traceId: "trace",
          spanId: "model",
          model: { adapterId: "a", modelId: "m" },
          messageCount: 1,
          usedTools: true,
          durationMs: 120,
          success: true,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cacheReadTokens: 40,
            cacheWriteTokens: 7,
            reasoningTokens: 5,
          },
          costs: { micro_usd: 12 },
        },
        3,
      ),
      event(
        {
          type: "tool_call_completed",
          turnId: "turn-1",
          traceId: "trace",
          spanId: "tools",
          toolCallId: "call-1",
          toolName: "run_command",
          durationMs: 50,
          transportOk: true,
          outcome: "failed",
          exitCode: 1,
          fromCache: false,
          inputBytes: 10,
          outputBytes: 200,
          outputChars: 200,
          admittedResultBytes: 150,
          admittedResultChars: 150,
        },
        4,
      ),
      event(
        {
          type: "context_compacted",
          trigger: "auto",
          activeTurnId: "turn-1",
          replacementHistory: [],
          beforeMessageCount: 10,
          afterMessageCount: 2,
        },
        5,
      ),
      event({ type: "turn_completed", turnId: "turn-1", status: "completed" }, 6),
      event(
        {
          type: "session_state",
          coveredThroughSeq: 6,
          userTurns: 1,
          title: "Inspect work",
          traceIds: ["trace"],
          status: "active",
        },
        7,
      ),
    ]);

    expect(inspection).toMatchObject({
      sessionId: "session-1",
      title: "Inspect work",
      completedTurns: 1,
      inProgressTurns: 0,
      totals: {
        modelCalls: 1,
        toolCalls: 1,
        promptTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 7,
        cacheHitRate: 0.4,
        toolOutputBytes: 200,
        canonicalToolResultBytes: 150,
        transportFailures: 0,
        compactions: 1,
        costs: { micro_usd: 12 },
      },
    });
    expect(inspection.turns[0]).toMatchObject({
      turnId: "turn-1",
      status: "completed",
      cacheReadTokens: 40,
      cacheWriteTokens: 7,
      cacheHitRate: 0.4,
      outcomes: { failed: 1 },
      transportFailures: 0,
      compactions: 1,
    });
    expect(renderSessionInspection(inspection)).toContain(
      "40 cache read, 7 cache write, 40.0% cache hit",
    );
  });

  it("keeps incomplete and maintenance activity explicit", () => {
    const inspection = projectSessionInspection(meta, [
      event(
        {
          type: "model_call_completed",
          traceId: "trace",
          spanId: "maintenance",
          model: { adapterId: "a", modelId: "m" },
          messageCount: 1,
          usedTools: false,
          durationMs: 10,
          success: true,
        },
        1,
      ),
      event(
        {
          type: "user_input_recorded",
          turnId: "turn-open",
          inputKind: "initial",
          input: {
            version: 1,
            nodes: [{ type: "text", text: "open" }],
            attachments: [],
          },
        },
        2,
      ),
    ]);

    expect(inspection.inProgressTurns).toBe(1);
    expect(inspection.unattributedModelCalls).toBe(1);
    expect(inspection.warnings).toContain(
      "1 model call(s) and 0 tool call(s) are outside a user turn.",
    );
  });
});
