import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "../../domains/session/model/sessionEvents";
import { renderToolAggregation } from "./renderToolAggregationInspection";
import { projectToolAggregation } from "./toolAggregationInspection";

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
  return { ...value, seq, timestamp: seq * 1_000 } as SessionEvent;
}

function toolEvents(
  turnId: string,
  seq: number,
  toolCallId: string,
  toolName: string,
  result: string,
  durationMs: number,
  outcome: "succeeded" | "failed" = "succeeded",
): SessionEvent[] {
  return [
    event(
      {
        type: "message_recorded",
        turnId,
        source: { kind: "model" },
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: toolCallId, name: toolName, arguments: '{"value":1}' }],
        },
      },
      seq,
    ),
    event(
      {
        type: "tool_call_completed",
        turnId,
        traceId: "trace",
        spanId: `span-${toolCallId}`,
        toolCallId,
        toolName,
        durationMs,
        transportOk: outcome === "succeeded",
        outcome,
        fromCache: false,
        inputBytes: 11,
        outputBytes: result.length,
        outputChars: result.length,
      },
      seq + 1,
    ),
    event(
      {
        type: "message_recorded",
        turnId,
        source: { kind: "tool" },
        message: { role: "tool", tool_call_id: toolCallId, name: toolName, content: result },
      },
      seq + 2,
    ),
  ];
}

const events: SessionEvent[] = [
  event(
    {
      type: "model_call_completed",
      turnId: "turn-1",
      traceId: "trace",
      spanId: "model-1",
      model: { adapterId: "a", modelId: "m" },
      messageCount: 1,
      input: {
        messagesByRole: { system: 1, user: 1, assistant: 0, tool: 0 },
        messageChars: 100,
        systemPromptChars: 50,
        toolResultChars: 0,
        toolDefinitionCount: 4,
        toolSchemaBytes: 400,
        toolDefinitions: [
          { name: "grep", schemaBytes: 100 },
          { name: "read_file", schemaBytes: 100 },
          { name: "edit_file", schemaBytes: 100 },
          { name: "run_command", schemaBytes: 100 },
        ],
      },
      usedTools: true,
      durationMs: 10,
      success: true,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    },
    1,
  ),
  ...toolEvents(
    "turn-1",
    2,
    "call-1",
    "grep",
    "src/a.ts\n> 1 | alpha\n  2 | context\n> 3 | beta",
    800,
  ),
  ...toolEvents(
    "turn-1",
    5,
    "call-2",
    "grep",
    "src/b.ts:10:gamma\nsrc/b.ts-11-context\n--\nsrc/b.ts:20:delta",
    700,
    "failed",
  ),
  ...toolEvents("turn-1", 8, "call-3", "read_file", "line\n".repeat(20), 600),
  event({ type: "turn_completed", turnId: "turn-1", status: "completed" }, 11),
];

describe("Tool aggregation inspection", () => {
  it("aggregates request and result tokens independently by Tool type", () => {
    const inspection = projectToolAggregation(meta, events);
    expect(inspection.summary.calls).toBe(3);
    expect(inspection.tools.map((tool) => [tool.toolName, tool.calls])).toEqual([
      ["grep", 2],
      ["read_file", 1],
    ]);
    expect(inspection.tools[0].requestTokens).toBeGreaterThan(0);
    expect(inspection.tools[0].resultTokens).toBeGreaterThan(0);
    expect(inspection.unusedTools).toEqual(["edit_file", "run_command"]);
    expect(inspection.tools[0].p95ResultTokens).toBeGreaterThanOrEqual(
      inspection.tools[0].averageResultTokens,
    );
    expect(renderToolAggregation(inspection)).toContain("avg result");
    expect(renderToolAggregation(inspection)).toContain("Unused tools (2)");
    expect(renderToolAggregation(inspection)).toContain("edit_file, run_command");
    expect(renderToolAggregation(inspection)).toContain("summed execution");
  });

  it("renders Turn aggregation, Tool detail, failures, and largest calls", () => {
    const turn = projectToolAggregation(meta, events, { turnId: "turn-1" });
    expect(renderToolAggregation(turn)).toContain("Tools — Turn turn-1");
    expect(renderToolAggregation(turn)).toContain("Largest results");

    const grep = projectToolAggregation(meta, events, { toolName: "grep" });
    const rendered = renderToolAggregation(grep);
    expect(grep.summary.calls).toBe(2);
    expect(grep.grepSearch).toMatchObject({
      measuredCalls: 2,
      matches: 4,
      files: 2,
      uniqueFiles: 2,
      rawWindows: 4,
      finalRanges: 3,
    });
    expect(rendered).toContain("Tool: grep");
    expect(rendered).toContain("Result / request");
    expect(rendered).toContain("Search output");
    expect(rendered).toContain("Output density");
    expect(rendered).toContain("window merge");
    expect(rendered).toContain("matches");
    expect(rendered).toContain("ctx");
    expect(rendered).toContain("Largest calls");
    expect(rendered).toContain("Failed calls");

    const turnGrep = projectToolAggregation(meta, events, {
      turnId: "turn-1",
      toolName: "grep",
    });
    expect(renderToolAggregation(turnGrep)).toContain("Calls");
    expect(() => projectToolAggregation(meta, events, { toolName: "edit_file" })).toThrow(
      "No edit_file Tool calls found",
    );
  });
});
