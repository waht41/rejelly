import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "../../domains/session/model/sessionEvents";
import { renderSessionInspection } from "./renderSessionInspection";
import { projectSessionInspection, resolveTurnId } from "./sessionInspection";

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
          beforeTokens: 12_000,
          afterTokens: 3_000,
          keptUserMessages: 2,
          durationMs: 1_500,
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
        prompt: {
          measuredCalls: 1,
          cumulativeTokens: 100,
          peakInputTokens: 100,
          uncachedTokens: 60,
          amplification: 1,
        },
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
      prompt: {
        measuredCalls: 1,
        cumulativeTokens: 100,
        peakInputTokens: 100,
        uncachedTokens: 60,
        amplification: 1,
      },
      cacheReadTokens: 40,
      cacheWriteTokens: 7,
      cacheHitRate: 0.4,
      outcomes: { failed: 1 },
      transportFailures: 0,
      compactions: 1,
    });
    expect(inspection.compactions).toEqual([
      {
        seq: 5,
        timestamp: 50,
        trigger: "auto",
        activeTurnId: "turn-1",
        beforeMessageCount: 10,
        afterMessageCount: 2,
        beforeTokens: 12_000,
        afterTokens: 3_000,
        keptUserMessages: 2,
        durationMs: 1_500,
      },
    ]);
    const rendered = renderSessionInspection(inspection);
    expect(rendered).toContain("#    turn");
    expect(rendered).toContain("1    turn-1");
    expect(rendered).toContain("completed");
    expect(resolveTurnId(inspection, "1")).toBe("turn-1");
    expect(resolveTurnId(inspection, "turn-1")).toBe("turn-1");
    expect(() => resolveTurnId(inspection, "2")).toThrow(
      "Turn number 2 not found in Session session-1; available Turns: 1-1.",
    );
    expect(rendered).toContain(
      "Prompt: 100 cumulative, 100 peak model input, 1.0x amplification, 60 uncached",
    );
    expect(rendered).toContain("Cache: 40 read, 7 write, 40.0% hit");
    expect(rendered).toContain("Compactions");
    expect(rendered).toContain(
      "- Compact [auto] 12,000 -> 3,000 tokens (-9,000, 75.0% reduction), 10 -> 2 messages, 1.5s",
    );

    const renderedWithTop = renderSessionInspection(inspection, {
      topContributors: [
        {
          turnId: "turn-1",
          turnNumber: 1,
          address: "3",
          label: "run_command result",
          toolCallId: "call-1",
          tokens: 50,
          tokenSource: "estimated",
          share: 0.5,
        },
      ],
    });
    expect(renderedWithTop).toContain("Largest segments");
    expect(renderedWithTop).toContain(
      "- Turn 1 #3 run_command result [call-1]: ~50 tokens (50.0%)",
    );
  });

  it("projects cumulative Prompt metrics and keeps per-Turn amplification separate", () => {
    const inspection = projectSessionInspection(meta, [
      event(
        {
          type: "model_call_completed",
          turnId: "turn-1",
          traceId: "trace",
          spanId: "model-1",
          model: { adapterId: "a", modelId: "m" },
          messageCount: 1,
          usedTools: true,
          durationMs: 10,
          success: true,
          usage: {
            promptTokens: 100,
            completionTokens: 10,
            totalTokens: 110,
            cacheReadTokens: 40,
          },
        },
        1,
      ),
      event(
        {
          type: "model_call_completed",
          turnId: "turn-1",
          traceId: "trace",
          spanId: "model-2",
          model: { adapterId: "a", modelId: "m" },
          messageCount: 2,
          usedTools: false,
          durationMs: 10,
          success: true,
          usage: {
            promptTokens: 130,
            completionTokens: 10,
            totalTokens: 140,
            cacheReadTokens: 120,
          },
        },
        2,
      ),
      event(
        {
          type: "model_call_completed",
          turnId: "turn-2",
          traceId: "trace",
          spanId: "model-3",
          model: { adapterId: "a", modelId: "m" },
          messageCount: 3,
          usedTools: false,
          durationMs: 10,
          success: true,
          usage: {
            promptTokens: 120,
            completionTokens: 10,
            totalTokens: 130,
            cacheReadTokens: 110,
          },
        },
        3,
      ),
    ]);

    expect(inspection.totals.prompt).toMatchObject({
      measuredCalls: 3,
      cumulativeTokens: 350,
      peakInputTokens: 130,
      latestInputTokens: 120,
      uncachedTokens: 80,
      amplification: 350 / 130,
    });
    expect(inspection.turns[0]?.prompt).toMatchObject({
      cumulativeTokens: 230,
      peakInputTokens: 130,
      amplification: 230 / 130,
    });
    expect(inspection.turns[1]?.prompt).toMatchObject({
      cumulativeTokens: 120,
      peakInputTokens: 120,
      amplification: 1,
    });
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
