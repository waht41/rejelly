import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "../../domains/session/model/sessionEvents";
import { renderInitialContextInspection } from "./renderCheckpointInspection";
import { renderSegmentInspection } from "./renderSegmentInspection";
import { extractSegmentPayload, projectSegmentDrilldown } from "./segmentInspection";
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

function fixture(): SessionEvent[] {
  return [
    event(
      {
        type: "user_input_recorded",
        turnId: "turn-1",
        inputKind: "initial",
        input: { version: 1, kind: "resolved", nodes: [{ kind: "text", text: "explain" }] },
      },
      1,
    ),
    event(
      {
        type: "model_call_completed",
        turnId: "turn-1",
        traceId: "trace",
        spanId: "model",
        model: { adapterId: "a", modelId: "m" },
        messageCount: 1,
        usedTools: false,
        durationMs: 10,
        success: true,
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          reasoningTokens: 5,
          totalTokens: 110,
        },
      },
      2,
    ),
    event(
      {
        type: "message_recorded",
        turnId: "turn-1",
        source: { kind: "model" },
        message: { role: "assistant", content: "persisted answer" },
      },
      3,
    ),
    event(
      {
        type: "message_recorded",
        turnId: "turn-1",
        source: { kind: "agent_runtime" },
        message: { role: "user", content: "retry notice" },
      },
      4,
    ),
    event(
      {
        type: "context_compacted",
        trigger: "auto",
        activeTurnId: "turn-1",
        replacementHistory: [{ role: "user", content: "summary bridge" }],
        beforeMessageCount: 4,
        afterMessageCount: 1,
        beforeTokens: 130,
        afterTokens: 40,
      },
      5,
    ),
    event({ type: "turn_completed", turnId: "turn-1", status: "completed" }, 6),
  ];
}

describe("Segment inspection", () => {
  it("drills into persisted user, assistant, runtime, and compaction payloads", () => {
    const events = fixture();
    const waterfall = projectTurnWaterfall(meta, events, "turn-1");

    const user = projectSegmentDrilldown(meta, events, waterfall, "1");
    expect(user).toMatchObject({
      type: "segment_inspection_v1",
      kind: "user",
      payload: { kind: "frozen_user_input" },
    });
    if (user.type !== "segment_inspection_v1") throw new Error("expected Segment inspection");
    expect(extractSegmentPayload(user)).toContain('"text": "explain"');

    expect(projectSegmentDrilldown(meta, events, waterfall, "3")).toMatchObject({
      type: "segment_inspection_v1",
      kind: "assistant",
      payload: { kind: "message", value: { content: "persisted answer" } },
    });
    expect(projectSegmentDrilldown(meta, events, waterfall, "4")).toMatchObject({
      type: "segment_inspection_v1",
      kind: "runtime",
      payload: { kind: "message", value: { content: "retry notice" } },
    });
    expect(projectSegmentDrilldown(meta, events, waterfall, "5")).toMatchObject({
      type: "segment_inspection_v1",
      kind: "compaction",
      payload: {
        kind: "compaction",
        value: { replacementHistory: [{ content: "summary bridge" }] },
      },
    });
  });

  it("drills into Initial context composition through C1", () => {
    const events: SessionEvent[] = [
      event(
        {
          type: "user_input_recorded",
          turnId: "turn-prior",
          inputKind: "initial",
          input: {
            version: 1,
            kind: "resolved",
            nodes: [{ kind: "text", text: "history" }],
          },
        },
        1,
      ),
      event(
        {
          type: "message_recorded",
          turnId: "turn-prior",
          source: { kind: "model" },
          message: { role: "assistant", content: "answer" },
        },
        2,
      ),
      event({ type: "turn_completed", turnId: "turn-prior", status: "completed" }, 3),
      event(
        {
          type: "user_input_recorded",
          turnId: "turn-current",
          inputKind: "initial",
          input: { version: 1, kind: "resolved", nodes: [{ kind: "text", text: "next" }] },
        },
        4,
      ),
      event(
        {
          type: "model_call_completed",
          turnId: "turn-current",
          traceId: "trace",
          spanId: "model-current",
          model: { adapterId: "a", modelId: "m" },
          messageCount: 3,
          input: {
            messagesByRole: { system: 1, user: 2, assistant: 1, tool: 0 },
            messageChars: 417,
            systemPromptChars: 400,
            toolResultChars: 0,
            toolDefinitionCount: 2,
            toolSchemaBytes: 800,
            toolDefinitions: [
              { name: "edit_file", schemaBytes: 500 },
              { name: "read_file", schemaBytes: 300 },
            ],
          },
          usedTools: true,
          durationMs: 10,
          success: true,
          usage: { promptTokens: 201, completionTokens: 0, totalTokens: 201 },
        },
        5,
      ),
    ];
    const waterfall = projectTurnWaterfall(meta, events, "turn-current");
    const inspection = projectSegmentDrilldown(meta, events, waterfall, "C1");

    expect(inspection).toMatchObject({
      type: "initial_context_inspection_v1",
      address: "C1",
      tokens: 200,
      providerPromptTokens: 201,
      estimatedTurnInputTokens: 1,
      estimatedNamedComponentTokens: 304,
      reconciliationDeltaTokens: -104,
      components: [
        { kind: "system_instructions", tokens: 66, estimatedTokens: 100, share: 0.33 },
        { kind: "tool_definitions", tokens: 131, estimatedTokens: 200, share: 0.655 },
        { kind: "prior_conversation", tokens: 3, estimatedTokens: 4, share: 0.015 },
      ],
      toolDefinitions: [
        { name: "edit_file", tokens: 82 },
        { name: "read_file", tokens: 49 },
      ],
    });
    if (inspection.type !== "initial_context_inspection_v1") {
      throw new Error("expected Initial context inspection");
    }
    const rendered = renderInitialContextInspection(inspection);
    expect(rendered).toContain("Tool definitions (share of reconciled Tool definitions)");
    expect(rendered).toContain("Reconciliation delta: -104 tokens");
    expect(rendered).not.toMatch(/-\d+\.\d+%/);
    expect(inspection.components.reduce((sum, component) => sum + component.tokens, 0)).toBe(200);
    expect(inspection.warnings).toContain(
      "Estimated named components (304 tokens) exceed reconciled Initial context (200 tokens); displayed component tokens were proportionally scaled to fit.",
    );
    expect(extractSegmentPayload(inspection)).toContain('"system_instructions"');
  });

  it("keeps token-only reasoning inspectable without inventing persisted content", () => {
    const events = fixture();
    const waterfall = projectTurnWaterfall(meta, events, "turn-1");
    const reasoning = projectSegmentDrilldown(meta, events, waterfall, "2");

    expect(reasoning).toMatchObject({
      type: "segment_inspection_v1",
      kind: "reasoning",
      tokens: 5,
      unavailableReason: expect.stringContaining("reasoning token count"),
    });
    if (reasoning.type !== "segment_inspection_v1") throw new Error("expected Segment inspection");
    expect(renderSegmentInspection(reasoning)).toContain("[unavailable:");
    expect(() => extractSegmentPayload(reasoning)).toThrow("has no durable payload");
  });
});
