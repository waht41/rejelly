import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventBus, EVENTS, TRACE_EVENT_SCHEMA_VERSION } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_INPUT_METRICS_TRACE_ATTRIBUTE } from "../../../shared/model/observation/modelInputMetrics";
import { MODEL_RETRY_METRICS_TRACE_ATTRIBUTE } from "../../../shared/model/observation/modelRetryMetrics";
import { recordInitialTextInput } from "../__tests__/sessionTestInput";
import { readSessionEvents } from "../journal/sessionJsonlStore";
import { observeSessionRecorder } from "./sessionObservationRecorder";
import { openSessionRecorder } from "./sessionRecorder";

describe("sessionObservationRecorder", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let sessionsRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-observation-"));
    workspaceRoot = path.join(tmpDir, "workspace");
    sessionsRoot = path.join(tmpDir, "sessions");
    await fs.mkdir(workspaceRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("projects matching Core model and tool facts before the Turn checkpoint", async () => {
    const eventBus = createEventBus();
    const modelConfiguration = {
      modelId: "model-a",
      provider: "openai",
      protocol: "responses" as const,
      endpoint: "https://user-visible-gateway.test/v1?tenant=alpha",
      reasoningEffort: "high",
    };
    const base = await openSessionRecorder({
      workspaceRoot,
      sessionsRoot,
      sessionId: "observed",
      traceId: "trace-1",
      originator: "evil-jelly-cli",
      appVersion: "0.1.0",
      modelId: "model-a",
      provider: "openai",
      cwd: workspaceRoot,
    });
    const recorder = observeSessionRecorder(base, { eventBus, modelConfiguration });
    await recordInitialTextInput(recorder, "turn-1", "inspect usage");

    eventBus.emit({
      schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
      type: EVENTS.MODEL_CALL_END,
      trace: {
        traceId: "trace-1",
        spanId: "model-span",
        parentSpanId: "turn-span",
        attributes: {
          [MODEL_INPUT_METRICS_TRACE_ATTRIBUTE]: {
            messagesByRole: { system: 1, user: 1, assistant: 1, tool: 1 },
            messageChars: 80,
            systemPromptChars: 20,
            toolResultChars: 30,
            toolDefinitionCount: 2,
            toolSchemaBytes: 400,
          },
          [MODEL_RETRY_METRICS_TRACE_ATTRIBUTE]: {
            attempts: [
              {
                attempt: 1,
                status: "failed",
                durationMs: 25,
                errorCode: "rate_limit",
                retryDelayMs: 100,
              },
              { attempt: 2, status: "succeeded", durationMs: 125 },
            ],
            totalRetryDelayMs: 100,
          },
        },
      },
      timestamp: 10,
      adapterId: "adapter-a",
      provider: "openai",
      messageCount: 4,
      usedTools: true,
      rawText: "not duplicated into metric event",
      reasoning: "also not duplicated",
      duration: 125,
      ttft: 20,
      usage: {
        promptTokens: 40,
        completionTokens: 5,
        totalTokens: 45,
        details: { cacheReadTokens: 12, reasoningTokens: 2 },
      },
      costs: {},
      finishReason: "stop",
      success: true,
    });
    eventBus.emit({
      schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
      type: EVENTS.TOOLS_EXECUTE_END,
      trace: { traceId: "trace-1", spanId: "tool-span", parentSpanId: "turn-span" },
      timestamp: 11,
      toolCallsCount: 1,
      toolNames: ["read_file"],
      successCount: 1,
      failureCount: 0,
      duration: 9,
      toolResults: [
        {
          callId: "tool-call-1",
          toolName: "read_file",
          input: { path: "README.md" },
          output: "hello",
          duration: 8,
          success: true,
          cache: true,
        },
      ],
      success: true,
    });
    await recorder.recordToolObservation("turn-1", "tool-call-1", {
      toolName: "read_file",
      summary: "[Tools] read_file → README.md",
      ok: true,
      outcome: "succeeded",
    });
    await recorder.recordMessage(
      "turn-1",
      { kind: "tool" },
      { role: "tool", tool_call_id: "tool-call-1", content: "hello" },
    );

    // Same event type from another segment must never leak into this Session.
    eventBus.emit({
      schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
      type: EVENTS.MODEL_CALL_END,
      trace: { traceId: "other-trace", spanId: "other-span", parentSpanId: "" },
      timestamp: 12,
      adapterId: "adapter-a",
      messageCount: 1,
      usedTools: false,
      rawText: "ignored",
      duration: 1,
      success: true,
    });

    await recorder.completeTurn("turn-1", "completed", {
      totalTokens: 45,
      promptTokens: 40,
      completionTokens: 5,
      cacheReadTokens: 12,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      callCount: 1,
      costs: {},
      lastContextTokens: 40,
      lastCacheReadTokens: 12,
    });
    await recorder.close();

    const stored = await readSessionEvents(workspaceRoot, "observed", { sessionsRoot });
    const modelCalls = stored.events.filter((event) => event.type === "model_call_completed");
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({
      turnId: "turn-1",
      traceId: "trace-1",
      spanId: "model-span",
      model: {
        adapterId: "adapter-a",
        modelId: "model-a",
        provider: "openai",
        protocol: "responses",
        endpoint: modelConfiguration.endpoint,
        reasoningEffort: "high",
      },
      durationMs: 125,
      input: {
        messagesByRole: { system: 1, user: 1, assistant: 1, tool: 1 },
        toolResultChars: 30,
        toolSchemaBytes: 400,
      },
      usage: { totalTokens: 45, cacheReadTokens: 12, reasoningTokens: 2 },
      costs: {},
      attemptCount: 2,
      retryCount: 1,
      totalRetryDelayMs: 100,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          durationMs: 25,
          errorCode: "rate_limit",
          retryDelayMs: 100,
        },
        { attempt: 2, status: "succeeded", durationMs: 125 },
      ],
    });
    expect(modelCalls[0]).not.toHaveProperty("rawText");
    expect(modelCalls[0]).not.toHaveProperty("reasoning");

    expect(stored.events).toContainEqual(
      expect.objectContaining({
        type: "tool_call_completed",
        turnId: "turn-1",
        toolCallId: "tool-call-1",
        durationMs: 8,
        transportOk: true,
        outcome: "succeeded",
        fromCache: true,
        outputBytes: 5,
        outputChars: 5,
        admittedResultBytes: 5,
        admittedResultChars: 5,
        truncated: false,
      }),
    );

    const modelIndex = stored.events.findIndex((event) => event.type === "model_call_completed");
    const toolIndex = stored.events.findIndex((event) => event.type === "tool_call_completed");
    const budgetIndex = stored.events.findIndex((event) => event.type === "budget_updated");
    expect(modelIndex).toBeLessThan(budgetIndex);
    expect(toolIndex).toBeLessThan(budgetIndex);
  });
});
