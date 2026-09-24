import {
  augmentModel,
  createAgent,
  createEventBus,
  EVENTS,
  type ModelAdapter,
  type ModelCallEndEvent,
  promptChat,
  runWith,
} from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MODEL_INPUT_METRICS_TRACE_ATTRIBUTE,
  projectModelInputMetrics,
  readModelInputMetrics,
  withModelInputMetrics,
} from "./modelInputMetrics";

function successfulModel(): ModelAdapter {
  return {
    id: "model-input-metrics-test",
    stream: async function* () {
      yield { type: "text", content: "ok" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

describe("modelInputMetrics", () => {
  it("projects prompt composition without retaining prompt text", () => {
    const metrics = projectModelInputMetrics([
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "calling" },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ]);

    expect(metrics).toMatchObject({
      messagesByRole: { system: 1, user: 1, assistant: 1, tool: 1 },
      messageChars: 23,
      systemPromptChars: 5,
      systemPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      systemInstructions: [{ chars: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      toolResultChars: 6,
      toolDefinitionCount: 0,
      toolSchemaBytes: 0,
    });
    expect(JSON.stringify(metrics)).not.toContain("rules");
    expect(JSON.stringify(metrics)).not.toContain("result");
  });

  it("records per-Tool schema sizes without retaining Tool schemas", () => {
    const metrics = projectModelInputMetrics([], {
      tools: [
        {
          name: "grep",
          description: "Search files",
          parameters: z.object({ query: z.string() }),
          handler: async () => "ok",
        },
      ],
    });

    expect(metrics.toolDefinitions).toEqual([
      {
        name: "grep",
        schemaBytes: expect.any(Number),
        schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(metrics.toolSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metrics.toolSchemaBytes).toBeGreaterThan(metrics.toolDefinitions?.[0].schemaBytes ?? 0);
    expect(JSON.stringify(metrics)).not.toContain("Search files");
    expect(JSON.stringify(metrics)).not.toContain("query");
  });

  it("keeps hashes stable for equal input and changes them with the input", () => {
    const first = projectModelInputMetrics([{ role: "system", content: "rules" }]);
    const repeated = projectModelInputMetrics([{ role: "system", content: "rules" }]);
    const changed = projectModelInputMetrics([{ role: "system", content: "updated rules" }]);

    expect(first.systemPromptSha256).toBe(repeated.systemPromptSha256);
    expect(first.systemPromptSha256).not.toBe(changed.systemPromptSha256);
  });

  it("attaches metrics to the matching model-call end span", async () => {
    const eventBus = createEventBus();
    const modelEnds: ModelCallEndEvent[] = [];
    eventBus.subscribe(EVENTS.MODEL_CALL_END, (event) => modelEnds.push(event));
    const model = augmentModel(successfulModel(), [withModelInputMetrics()]);
    const agent = createAgent({
      id: "model-input-metrics-agent",
      model,
      handler: async () => promptChat({ message: { role: "user", content: "hello" } }),
    });

    await runWith(() => agent({}), { eventBus });

    expect(modelEnds).toHaveLength(1);
    expect(readModelInputMetrics(modelEnds[0]?.trace.attributes)).toMatchObject({
      messagesByRole: { user: 1 },
      messageChars: expect.any(Number),
      toolDefinitionCount: 0,
    });
    expect(modelEnds[0]?.trace.attributes).toHaveProperty(MODEL_INPUT_METRICS_TRACE_ATTRIBUTE);
  });

  it("does not make direct adapter use depend on an Agent context", async () => {
    const model = augmentModel(successfulModel(), [withModelInputMetrics()]);
    const events = [];
    for await (const event of model.stream([{ role: "user", content: "hello" }])) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
  });
});
