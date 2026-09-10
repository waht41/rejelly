import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionMetaLine } from "../../domains/session/model/sessionEvents";
import {
  projectModelCallInspection,
  projectModelCallList,
  projectModelCalls,
} from "./modelCallInspection";
import { renderModelCallInspection, renderModelCallList } from "./renderModelCallInspection";

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

const events: SessionEvent[] = [
  event(
    {
      type: "user_input_recorded",
      turnId: "turn-1",
      inputKind: "initial",
      input: { version: 1, nodes: [{ type: "text", text: "hello" }], attachments: [] },
    },
    1,
  ),
  event(
    {
      type: "model_call_completed",
      turnId: "turn-1",
      traceId: "trace",
      spanId: "model-1",
      model: {
        adapterId: "adapter",
        modelId: "gpt-test",
        provider: "openai",
        protocol: "responses",
        endpoint: "https://gateway.test/v1",
      },
      messageCount: 2,
      input: {
        messagesByRole: { system: 1, user: 1, assistant: 0, tool: 0 },
        messageChars: 800,
        systemPromptChars: 500,
        toolResultChars: 0,
        toolDefinitionCount: 1,
        toolSchemaBytes: 200,
        toolDefinitions: [{ name: "grep", schemaBytes: 200 }],
      },
      usedTools: true,
      durationMs: 12_000,
      ttftMs: 1_000,
      finishReason: "tool_calls",
      success: true,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 80,
        reasoningTokens: 5,
      },
    },
    2,
  ),
  event(
    {
      type: "model_call_completed",
      turnId: "turn-1",
      traceId: "trace",
      spanId: "model-2",
      model: {
        adapterId: "adapter",
        modelId: "gpt-test",
        provider: "openai",
        protocol: "responses",
      },
      messageCount: 4,
      usedTools: false,
      durationMs: 30_000,
      ttftMs: 4_000,
      finishReason: "error",
      success: false,
      errorCode: "rate_limit",
      attemptCount: 3,
      retryCount: 2,
      totalRetryDelayMs: 1_800,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          durationMs: 320,
          errorCode: "rate_limit",
          retryDelayMs: 1_000,
        },
        {
          attempt: 2,
          status: "failed",
          durationMs: 410,
          errorCode: "rate_limit",
          retryDelayMs: 800,
        },
        { attempt: 3, status: "failed", durationMs: 28_000, errorCode: "rate_limit" },
      ],
    },
    3,
  ),
  event(
    {
      type: "user_input_recorded",
      turnId: "turn-2",
      inputKind: "initial",
      input: { version: 1, nodes: [{ type: "text", text: "next" }], attachments: [] },
    },
    4,
  ),
  event(
    {
      type: "model_call_completed",
      turnId: "turn-2",
      traceId: "trace",
      spanId: "model-3",
      model: {
        adapterId: "adapter",
        modelId: "gpt-mini",
        provider: "openai",
        protocol: "responses",
      },
      messageCount: 5,
      usedTools: false,
      durationMs: 8_000,
      ttftMs: 800,
      finishReason: "stop",
      success: true,
      usage: {
        promptTokens: 150,
        completionTokens: 30,
        totalTokens: 180,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        reasoningTokens: 10,
      },
    },
    5,
  ),
];

describe("Model Call inspection", () => {
  it("assigns stable Session-global M addresses and Turn numbers", () => {
    expect(
      projectModelCalls(meta, events).map(({ address, turnNumber }) => ({ address, turnNumber })),
    ).toEqual([
      { address: "M1", turnNumber: 1 },
      { address: "M2", turnNumber: 1 },
      { address: "M3", turnNumber: 2 },
    ]);
  });

  it("renders a Session summary with notable calls instead of dumping every call", () => {
    const inspection = projectModelCallList(meta, events);
    expect(inspection.summary).toMatchObject({
      calls: 3,
      successful: 2,
      failed: 1,
      retries: 2,
      completionTokens: 50,
      reasoningTokens: 15,
      cacheReadTokens: 110,
      cacheHitRate: 0.44,
    });
    const rendered = renderModelCallList(inspection);
    expect(rendered).toContain("Model calls");
    expect(rendered).toContain("Notable calls");
    expect(rendered).toContain("M2");
    expect(rendered).toContain("rate_limit, 2 retries");
    expect(rendered).not.toContain("Model: gpt-test");
  });

  it("lists every Turn call and supports Session-global ranges and profiles", () => {
    const turn = projectModelCallList(meta, events, { turnId: "turn-1" });
    expect(turn.calls.map((call) => call.address)).toEqual(["M1", "M2"]);
    expect(renderModelCallList(turn)).toContain("Model calls — Turn turn-1");
    expect(renderModelCallList(turn, { view: "latency" })).toContain("output tok/s");

    const range = projectModelCallList(meta, events, { selector: "M2..3" });
    expect(range.calls.map((call) => call.address)).toEqual(["M2", "M3"]);
    expect(renderModelCallList(range, { view: "transport" })).toContain("retry delay");
  });

  it("renders semantic single-call detail with optional input and aggregate attempts", () => {
    const call = projectModelCallInspection(meta, events, "M1");
    const rendered = renderModelCallInspection(call, { input: true, attempts: true });
    expect(rendered).toContain("Model call M1");
    expect(rendered).toContain("cache read");
    expect(rendered).toContain("Input composition");
    expect(rendered).toContain("grep");
    expect(rendered).toContain("Attempts");

    const failed = renderModelCallInspection(projectModelCallInspection(meta, events, "M2"), {
      attempts: true,
    });
    expect(failed).toContain("A1   failed");
    expect(failed).toContain("+1.0s backoff");
  });

  it("rejects invalid and out-of-bounds addresses", () => {
    expect(() => projectModelCallInspection(meta, events, "M0")).toThrow("Expected M1 or 1");
    expect(() => projectModelCallList(meta, events, { selector: "M2..M8" })).toThrow(
      "outside this Session",
    );
  });
});
