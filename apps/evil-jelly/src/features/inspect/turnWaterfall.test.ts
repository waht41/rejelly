import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "../../domains/session/model/sessionEvents";
import { renderTurnWaterfall } from "./renderTurnWaterfall";
import { projectTurnWaterfall } from "./turnWaterfall";

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

describe("turn waterfall", () => {
  it("interleaves provider checkpoints, model output, tool results, and compaction", () => {
    const inspection = projectTurnWaterfall(
      meta,
      [
        event(
          {
            type: "user_input_recorded",
            turnId: "turn-1",
            inputKind: "initial",
            input: { version: 1, kind: "resolved", nodes: [{ kind: "text", text: "hello" }] },
          },
          1,
        ),
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
              completionTokens: 20,
              totalTokens: 120,
              reasoningTokens: 5,
            },
          },
          2,
        ),
        event(
          {
            type: "message_recorded",
            turnId: "turn-1",
            source: { kind: "model" },
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call-1", name: "grep", arguments: "{}" },
                { id: "call-2", name: "read_file", arguments: '{"path":"a.ts"}' },
              ],
            },
          },
          3,
        ),
        event(
          {
            type: "message_recorded",
            turnId: "turn-1",
            source: { kind: "tool" },
            message: { role: "tool", tool_call_id: "call-1", content: "abcdefgh" },
          },
          4,
        ),
        event(
          {
            type: "model_call_completed",
            turnId: "turn-1",
            traceId: "trace",
            spanId: "model-2",
            model: { adapterId: "a", modelId: "m" },
            messageCount: 3,
            usedTools: false,
            durationMs: 10,
            success: true,
            usage: { promptTokens: 130, completionTokens: 0, totalTokens: 130 },
          },
          5,
        ),
        event(
          {
            type: "context_compacted",
            trigger: "auto",
            activeTurnId: "turn-1",
            replacementHistory: [],
            beforeMessageCount: 3,
            afterMessageCount: 1,
            beforeTokens: 150,
            afterTokens: 40,
          },
          6,
        ),
        event({ type: "turn_completed", turnId: "turn-1", status: "completed" }, 7),
      ],
      "turn-1",
    );

    expect(inspection.peakContextTokens).toBe(150);
    expect(inspection.peakContextSource).toBe("provider");
    expect(inspection.segments[3].children).toMatchObject([
      { label: "grep request", toolCallId: "call-1" },
      { label: "read_file request", toolCallId: "call-2" },
    ]);
    expect(inspection.segments[4]).toMatchObject({
      label: "grep result",
      toolCallId: "call-1",
    });
    expect(
      inspection.segments.map(({ label, tokens, contextTokens }) => ({
        label,
        tokens,
        contextTokens,
      })),
    ).toEqual([
      { label: "user input", tokens: 2, contextTokens: 2 },
      { label: "prior context + system/tools", tokens: 98, contextTokens: 100 },
      { label: "reasoning", tokens: 5, contextTokens: 105 },
      { label: "parallel tools", tokens: 15, contextTokens: 120 },
      { label: "grep result", tokens: 2, contextTokens: 122 },
      { label: "provider input #2 reconciliation", tokens: 8, contextTokens: 130 },
      { label: "compact [auto]", tokens: -110, contextTokens: 40 },
    ]);
    const rendered = renderTurnWaterfall(inspection);
    expect(rendered).toContain("peak context 150");
    expect(rendered).toContain("┬ parallel tools");
    expect(rendered).toContain("├─ grep request [call-1]");
    expect(rendered).toContain("└─ read_file request [call-2]");
    expect(rendered).toContain("grep result [call-1]");
    expect(rendered).toContain("compact [auto]");
    expect(rendered).not.toContain("█");
    expect(rendered).toContain("~ estimated from canonical message content");
    expect(rendered).toContain("Provider reconciliation rows");
  });

  it("marks an estimated peak and renders negative provider reconciliation without a size bar", () => {
    const inspection = projectTurnWaterfall(
      meta,
      [
        event(
          {
            type: "user_input_recorded",
            turnId: "turn-1",
            inputKind: "initial",
            input: {
              version: 1,
              kind: "resolved",
              nodes: [{ kind: "text", text: "hello" }],
            },
          },
          1,
        ),
        event(
          {
            type: "model_call_completed",
            turnId: "turn-1",
            traceId: "trace",
            spanId: "model-1",
            model: { adapterId: "a", modelId: "m" },
            messageCount: 1,
            usedTools: false,
            durationMs: 10,
            success: true,
            usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
          },
          2,
        ),
        event(
          {
            type: "message_recorded",
            turnId: "turn-1",
            source: { kind: "tool" },
            message: {
              role: "tool",
              tool_call_id: "call-1",
              content: "a".repeat(80),
            },
          },
          3,
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
            usage: { promptTokens: 120, completionTokens: 0, totalTokens: 120 },
          },
          4,
        ),
      ],
      "turn-1",
    );

    expect(inspection.peakContextTokens).toBe(150);
    expect(inspection.peakContextSource).toBe("estimated");
    expect(inspection.segments.at(-1)).toMatchObject({
      kind: "reconciliation",
      tokens: -30,
      contextTokens: 120,
    });
    const reconciliationLine = renderTurnWaterfall(inspection)
      .split("\n")
      .find((line) => line.includes("provider input #2 reconciliation"));
    expect(reconciliationLine).toBeDefined();
    expect(reconciliationLine?.trimEnd().endsWith("120")).toBe(true);
    expect(renderTurnWaterfall(inspection)).toContain("peak context ~150");
  });
});
