import type { JsonObject, Message } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResponseParams } from "../index";
import { createOpenAIAdapter, toOpenAIResponseInput } from "../index";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    baseURL = "https://mock.test/v1";
    chat = { completions: { create: vi.fn() } };
    responses = { create: mocks.create };
  },
  APIError: class APIError extends Error {},
}));

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1,
    output_text: "answer",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "test-model",
    output: [],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    background: false,
    conversation: null,
    max_output_tokens: null,
    previous_response_id: null,
    prompt: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: "default",
    status: "completed",
    text: { format: { type: "text" } },
    truncation: "disabled",
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 15,
    },
    user: null,
    ...overrides,
  };
}

async function* events(...items: Record<string, unknown>[]) {
  for (const item of items) yield item;
}

async function drain(adapter: ReturnType<typeof createOpenAIAdapter>, messages: Message[] = []) {
  const result = [];
  for await (const event of adapter.stream(messages)) result.push(event);
  return result;
}

describe("OpenAI Responses adapter", () => {
  beforeEach(() => mocks.create.mockReset());

  it("keeps model provider optional while using a stable adapter state owner", async () => {
    mocks.create.mockImplementation(() =>
      events({ type: "response.completed", response: response(), sequence_number: 1 }),
    );
    const adapter = createOpenAIAdapter({ api: "responses", modelId: "test-model" });
    const result = await drain(adapter, [{ role: "user", content: "hi" }]);

    expect(adapter.provider).toBeUndefined();
    expect(result.find((event) => event.type === "state")).toMatchObject({
      state: { kind: "@rejelly/adapter-openai/responses" },
    });
    expect(result.find((event) => event.type === "state")).not.toHaveProperty(
      "state.payload.provider",
    );
  });

  it("streams reasoning, text, usage, durable output state, and finish without waiting for DONE", async () => {
    const output: JsonObject[] = [
      {
        id: "rs_1",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "thought" }],
        encrypted_content: "opaque",
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
    ];
    const completed = response({ output });
    mocks.create.mockImplementation(() =>
      events(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          output_index: 0,
          summary_index: 0,
          delta: "thought",
          sequence_number: 1,
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 1,
          content_index: 0,
          delta: "answer",
          logprobs: [],
          sequence_number: 2,
        },
        { type: "response.completed", response: completed, sequence_number: 3 },
      ),
    );

    const adapter = createOpenAIAdapter({
      api: "responses",
      modelId: "test-model",
      provider: "openrouter",
    });
    const result = await drain(adapter, [{ role: "user", content: "hi" }]);

    expect(result).toEqual([
      { type: "reasoning", content: "thought" },
      { type: "text", content: "answer" },
      {
        type: "usage",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          details: { cacheReadTokens: 2, reasoningTokens: 3 },
        },
      },
      {
        type: "state",
        state: {
          kind: "@rejelly/adapter-openai/responses",
          version: 1,
          payload: {
            endpoint: "https://mock.test/v1",
            provider: "openrouter",
            responseId: "resp_1",
            outputItems: output,
          },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          details: { cacheReadTokens: 2, reasoningTokens: 3 },
        },
      },
    ]);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      model: "test-model",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
  });

  it("streams compatible reasoning_text deltas used by DeepSeek", async () => {
    mocks.create.mockImplementation(() =>
      events(
        {
          type: "response.reasoning_text.delta",
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          delta: "deep ",
          sequence_number: 1,
        },
        {
          type: "response.reasoning_text.delta",
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          delta: "thought",
          sequence_number: 2,
        },
        {
          type: "response.reasoning_text.done",
          item_id: "rs_1",
          output_index: 0,
          content_index: 0,
          text: "deep thought",
          sequence_number: 3,
        },
        { type: "response.completed", response: response(), sequence_number: 4 },
      ),
    );

    const adapter = createOpenAIAdapter({ api: "responses", modelId: "test-model" });
    const result = await drain(adapter, [{ role: "user", content: "hi" }]);

    expect(result.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", content: "deep " },
      { type: "reasoning", content: "thought" },
    ]);
  });

  it("streams parallel function calls using Responses call_id and marks the turn as tool_calls", async () => {
    const output = [
      {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "first",
        arguments: '{"x":1}',
      },
      {
        id: "fc_2",
        type: "function_call",
        status: "completed",
        call_id: "call_2",
        name: "second",
        arguments: '{"y":2}',
      },
    ];
    mocks.create.mockImplementation(() =>
      events(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...output[0], status: "in_progress", arguments: "" },
          sequence_number: 1,
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: '{"x":1}',
          sequence_number: 2,
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...output[1], status: "in_progress", arguments: "" },
          sequence_number: 3,
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          output_index: 1,
          delta: '{"y":2}',
          sequence_number: 4,
        },
        { type: "response.completed", response: response({ output }), sequence_number: 5 },
      ),
    );

    const result = await drain(createOpenAIAdapter({ api: "responses", modelId: "test-model" }), [
      { role: "user", content: "call tools" },
    ]);

    expect(result.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", toolCall: { index: 0, id: "call_1", name: "first", arguments: "" } },
      {
        type: "tool_call",
        toolCall: { index: 0, id: "call_1", name: "first", arguments: '{"x":1}' },
      },
      { type: "tool_call", toolCall: { index: 1, id: "call_2", name: "second", arguments: "" } },
      {
        type: "tool_call",
        toolCall: { index: 1, id: "call_2", name: "second", arguments: '{"y":2}' },
      },
    ]);
    expect(result.at(-1)).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  it("preserves compatible include values while enforcing encrypted reasoning state", async () => {
    mocks.create.mockImplementation(() =>
      events({ type: "response.completed", response: response(), sequence_number: 1 }),
    );
    await drain(
      createOpenAIAdapter({
        api: "responses",
        modelId: "test-model",
        responseParams: {
          include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
        },
      }),
      [{ role: "user", content: "hi" }],
    );

    expect(mocks.create.mock.calls[0][0].include).toEqual([
      "message.output_text.logprobs",
      "reasoning.encrypted_content",
    ]);
  });

  it("replays ordered output items and maps tool results to function_call_output", () => {
    const outputItems: JsonObject[] = [
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque" },
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"id":1}',
      },
    ];
    const assistant: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", name: "lookup", arguments: '{"id":1}' }],
      provider_state: [
        {
          kind: "@rejelly/adapter-openai/responses",
          version: 1,
          payload: {
            endpoint: "https://mock.test/v1/",
            responseId: "resp_1",
            outputItems,
          },
        },
      ],
    };

    expect(
      toOpenAIResponseInput([assistant, { role: "tool", tool_call_id: "call_1", content: "ok" }], {
        endpoint: "https://mock.test/v1",
      }),
    ).toEqual({
      input: [...outputItems, { type: "function_call_output", call_id: "call_1", output: "ok" }],
    });
  });

  it("maps schema, function tools, tool choice, images, and system instructions", async () => {
    mocks.create.mockImplementation(() =>
      events({ type: "response.completed", response: response(), sequence_number: 1 }),
    );
    const adapter = createOpenAIAdapter({
      api: "responses",
      modelId: "test-model",
      schemaMode: "json_schema",
    });
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    for await (const _ of adapter.stream(
      [
        { role: "system", content: "be precise" },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", image: { url: "data:image/png;base64,AAAA", detail: "low" } },
          ],
        },
      ],
      {
        schema,
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: z.object({ id: z.number() }),
            handler: vi.fn(),
          },
        ],
        toolChoice: { type: "function", function: { name: "lookup" } },
      },
    )) {
      // drain
    }

    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      instructions: "be precise",
      text: { format: { type: "json_schema", name: "response", schema, strict: true } },
      tools: [{ type: "function", name: "lookup", description: "Lookup", strict: true }],
      tool_choice: { type: "function", name: "lookup" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            { type: "input_image", detail: "low", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    });
  });

  it.each<[ResponseParams, string]>([
    [{ store: true }, "store: false"],
    [{ previous_response_id: "resp_old" }, "previous_response_id"],
    [{ include: [] }, "reasoning.encrypted_content"],
  ])("rejects incompatible stateless params %#", async (responseParams, message) => {
    const adapter = createOpenAIAdapter({
      api: "responses",
      modelId: "test-model",
      responseParams,
    });
    await expect(drain(adapter, [{ role: "user", content: "hi" }])).rejects.toThrow(message);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not fall back to Chat when a Responses stream fails", async () => {
    mocks.create.mockImplementation(() =>
      events({
        type: "error",
        code: "invalid_prompt",
        message: "unsupported",
        param: null,
        sequence_number: 1,
      }),
    );
    const adapter = createOpenAIAdapter({ api: "responses", modelId: "test-model" });
    const result = drain(adapter, [{ role: "user", content: "hi" }]);
    await expect(result).rejects.toMatchObject({ name: "ModelCallError" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
