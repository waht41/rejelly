import { describe, expect, it } from "vitest";
import {
  isKnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { renderToolCallInspection } from "./renderToolCallInspection";
import {
  dumpToolCallPayload,
  findToolCallTurnId,
  projectToolCallBySegment,
  projectToolCallInspection,
  resolveSegmentToolCall,
} from "./toolCallInspection";
import { projectTopContributors, projectTurnWaterfall } from "./turnWaterfall";

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
        input: { version: 1, kind: "resolved", nodes: [{ kind: "text", text: "find x" }] },
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
        usedTools: true,
        durationMs: 10,
        success: true,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
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
          tool_calls: [{ id: "call-1", name: "grep", arguments: '{"pattern":"x","path":"src"}' }],
        },
      },
      3,
    ),
    event(
      {
        type: "tool_observation_recorded",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "grep",
        summary: "[Tools] grep → 45 lines",
        args: '{"pattern":"x","path":"src"}',
        ok: true,
        outcome: "succeeded",
      },
      4,
    ),
    event(
      {
        type: "tool_call_completed",
        turnId: "turn-1",
        traceId: "trace",
        spanId: "tool",
        toolCallId: "call-1",
        toolName: "grep",
        durationMs: 182,
        transportOk: true,
        outcome: "succeeded",
        fromCache: false,
        inputBytes: 28,
        outputBytes: 400,
        outputChars: 400,
        admittedResultBytes: 350,
        admittedResultChars: 350,
        truncated: false,
      },
      5,
    ),
    event(
      {
        type: "message_recorded",
        turnId: "turn-1",
        source: { kind: "tool" },
        message: {
          role: "tool",
          tool_call_id: "call-1",
          content: Array.from({ length: 45 }, (_, index) => `src/file-${index + 1}.ts:x`).join(
            "\n",
          ),
        },
      },
      6,
    ),
    event({ type: "turn_completed", turnId: "turn-1", status: "completed" }, 7),
  ];
}

describe("Tool call inspection", () => {
  it("pairs request and result when either waterfall segment is selected", () => {
    const events = fixture();
    const waterfall = projectTurnWaterfall(meta, events, "turn-1");

    expect(resolveSegmentToolCall(waterfall, "2")).toEqual({
      toolCallId: "call-1",
      side: "request",
    });
    expect(resolveSegmentToolCall(waterfall, "3")).toEqual({
      toolCallId: "call-1",
      side: "result",
    });

    const requestSelection = projectToolCallBySegment(meta, events, waterfall, "2");
    expect(requestSelection).toMatchObject({
      type: "tool_call_inspection_v1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "grep",
      selectedSide: "request",
      status: "succeeded",
      durationMs: 182,
      request: { address: "2", content: '{"pattern":"x","path":"src"}' },
      result: { address: "3", lines: 45 },
    });
    expect(dumpToolCallPayload(requestSelection)).toBe('{"pattern":"x","path":"src"}');

    const resultSelection = projectToolCallBySegment(meta, events, waterfall, "3");
    expect(dumpToolCallPayload(resultSelection)).toContain("src/file-45.ts:x");
    expect(renderToolCallInspection(resultSelection)).toContain("Tool call #3");
    expect(renderToolCallInspection(resultSelection)).toContain(
      "[truncated preview, showing 40/45 lines; use --full or --dump]",
    );
    expect(renderToolCallInspection(resultSelection, { full: true })).toContain("src/file-45.ts:x");
    expect(
      renderToolCallInspection({
        ...resultSelection,
        truncated: true,
        truncationReason: "size_limit",
      }),
    ).toContain(
      "[tool output was reduced before canonical admission: size_limit; the displayed result is complete as persisted]",
    );
  });

  it("locates a call across the Session and ranks addressable token contributors", () => {
    const events = fixture();
    const waterfall = projectTurnWaterfall(meta, events, "turn-1");

    expect(findToolCallTurnId(events, "call-1")).toBe("turn-1");
    expect(projectToolCallInspection(meta, events, waterfall, "call-1").selectedSide).toBe(
      "result",
    );
    expect(projectTopContributors(waterfall, 2)).toMatchObject([
      { address: "3", label: "grep result", toolCallId: "call-1" },
      { address: "2", label: "grep request", toolCallId: "call-1" },
    ]);
  });

  it("requires a child address for a parallel Tool request segment", () => {
    const events = fixture();
    const modelMessage = events.find(
      (candidate) =>
        isKnownSessionEvent(candidate) &&
        candidate.type === "message_recorded" &&
        candidate.source.kind === "model",
    );
    if (
      !modelMessage ||
      !isKnownSessionEvent(modelMessage) ||
      modelMessage.type !== "message_recorded"
    )
      throw new Error("missing model");
    modelMessage.message.tool_calls?.push({
      id: "call-2",
      name: "read_file",
      arguments: '{"path":"src/a.ts"}',
    });
    const waterfall = projectTurnWaterfall(meta, events, "turn-1");

    expect(() => resolveSegmentToolCall(waterfall, "2")).toThrow(
      "Segment 2 contains 2 Tool calls; select 2.1-2.2.",
    );
    expect(resolveSegmentToolCall(waterfall, "2.2")).toEqual({
      toolCallId: "call-2",
      side: "request",
    });
  });
});
