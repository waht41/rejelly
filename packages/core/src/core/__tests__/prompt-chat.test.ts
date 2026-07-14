import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel } from "../../testing/helpers";
import { AttemptsExhaustedError } from "../domain/errors";
import { createAgent } from "../engine/agent";
import { equipInstruction, equipTool } from "../facade/equip/equip";
import { expectValidator } from "../facade/expect/expect";
import { promptChat } from "../policy/prompt-chat";

describe("promptChat", () => {
  it("returns plain text without passing a schema", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse("plain answer");

    const agent = createAgent({
      id: "prompt_chat_text",
      model: mock.adapter,
      handler: async () => promptChat(),
    });

    const result = await agent({});

    expect(result).toEqual({
      data: "plain answer",
      delta: [{ role: "assistant", content: "plain answer" }],
    });
    expect(mock.calls.last()?.schema).toBeUndefined();
  });

  it("appends custom messages to initial messages", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse("plain answer");

    const agent = createAgent({
      id: "prompt_chat_custom_message",
      model: mock.adapter,
      handler: async () => {
        equipInstruction("base instruction");
        return promptChat({ message: { role: "user", content: "persisted user message" } });
      },
    });

    const result = await agent({});

    expect(result.data).toBe("plain answer");
    expect(result.delta).toEqual([{ role: "assistant", content: "plain answer" }]);
    expect(mock.calls.first()?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "base instruction" }],
        extra: { rejelly: { kind: "instruction" } },
      },
      {
        role: "user",
        content: [{ type: "text", text: "persisted user message" }],
      },
    ]);
  });

  it("runs validators before returning content", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse("plain answer");
    const validator = vi.fn().mockReturnValue(true);

    const agent = createAgent({
      id: "prompt_chat_validation_success",
      model: mock.adapter,
      handler: async () => {
        expectValidator(validator);
        return promptChat();
      },
    });

    const result = await agent({});

    expect(result.data).toBe("plain answer");
    expect(validator).toHaveBeenCalledWith("plain answer");
  });

  it("returns schema-validated data when schema is provided", async () => {
    const mock = createMockModel();
    const schema = z.object({ answer: z.string() });
    mock.setDefaultResponse('{"answer":"structured answer"}');

    const agent = createAgent({
      id: "prompt_chat_schema",
      model: mock.adapter,
      handler: async () => promptChat({ schema }),
    });

    const result = await agent({});

    expect(result).toEqual({
      data: { answer: "structured answer" },
      delta: [{ role: "assistant", content: '{"answer":"structured answer"}' }],
    });
    expect(mock.calls.last()?.schema).toBeDefined();
  });

  it("throws when chat content fails validation", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse("bad answer");

    const agent = createAgent({
      id: "prompt_chat_validation_failure",
      model: mock.adapter,
      maxRetries: 0,
      handler: async () => {
        expectValidator((data) => (data === "bad answer" ? "bad answer rejected" : true));
        return promptChat();
      },
    });

    const error = await agent({}).catch((err) => err);

    expect(error).toBeInstanceOf(AttemptsExhaustedError);
    expect(error.issues).toEqual(["bad answer rejected"]);
    expect(error.lastRawText).toBe("bad answer");
  });

  it("retries chat content validation using maxRetries", async () => {
    const mock = createMockModel();
    const validator = vi
      .fn()
      .mockImplementation((data) => (data === "fixed answer" ? true : "answer rejected"));

    mock.sequence([
      { type: "text", content: "bad answer" },
      { type: "text", content: "fixed answer" },
    ]);

    const agent = createAgent({
      id: "prompt_chat_validation_retry",
      model: mock.adapter,
      maxRetries: 1,
      handler: async () => {
        expectValidator(validator);
        return promptChat();
      },
    });

    const result = await agent({});

    expect(result.data).toBe("fixed answer");
    expect(result.delta).toEqual([
      { role: "assistant", content: "bad answer" },
      {
        role: "user",
        content: "Output validation failed:\nanswer rejected\nPlease fix the errors above.",
      },
      { role: "assistant", content: "fixed answer" },
    ]);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(mock.calls.count()).toBe(2);
    expect(mock.calls.last()?.messages).toEqual([
      { role: "assistant", content: "bad answer" },
      {
        role: "user",
        content: "Output validation failed:\nanswer rejected\nPlease fix the errors above.",
      },
    ]);
  });

  it("runs tools and returns the next text response", async () => {
    const mock = createMockModel();
    const searchHandler = vi.fn().mockResolvedValue("tool result");

    mock.sequence([
      {
        type: "tool_calls",
        calls: [{ id: "call_1", name: "search", arguments: { query: "test" } }],
      },
      { type: "text", content: "final answer" },
    ]);

    const agent = createAgent({
      id: "prompt_chat_tools",
      model: mock.adapter,
      handler: async () => {
        equipTool({
          name: "search",
          description: "Search for data",
          parameters: z.object({ query: z.string() }),
          handler: searchHandler,
        });
        return promptChat();
      },
    });

    const result = await agent({});

    expect(result.data).toBe("final answer");
    expect(result.delta).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", name: "search", arguments: '{"query":"test"}' }],
      },
      { role: "tool", tool_call_id: "call_1", content: "tool result" },
      { role: "assistant", content: "final answer" },
    ]);
    expect(searchHandler).toHaveBeenCalledWith({ query: "test" });
    expect(mock.calls.count()).toBe(2);
    expect(mock.calls.all().every((call) => call.schema === undefined)).toBe(true);
  });

  it("keeps within-step retry messages when a validation retry pivots to tool calls", async () => {
    const mock = createMockModel();
    const searchHandler = vi.fn().mockResolvedValue("tool result");
    const validator = vi
      .fn()
      .mockImplementation((data) => (data === "bad answer" ? "answer rejected" : true));

    // Attempt 0 returns content that fails validation; the retry (attempt 1)
    // pivots to a tool call instead of content; a later turn produces the final
    // answer.
    mock.sequence([
      { type: "text", content: "bad answer" },
      {
        type: "tool_calls",
        calls: [{ id: "call_1", name: "search", arguments: { query: "test" } }],
      },
      { type: "text", content: "final answer" },
    ]);

    const agent = createAgent({
      id: "prompt_chat_retry_then_tools",
      model: mock.adapter,
      maxRetries: 1,
      handler: async () => {
        expectValidator(validator);
        equipTool({
          name: "search",
          description: "Search for data",
          parameters: z.object({ query: z.string() }),
          handler: searchHandler,
        });
        return promptChat();
      },
    });

    const result = await agent({});

    expect(result.data).toBe("final answer");
    // Regression: the tool_calls branch used to return only the tool-call
    // message and drop the failed content + feedback accumulated within the
    // same step. They must survive in the delta.
    expect(result.delta).toEqual([
      { role: "assistant", content: "bad answer" },
      {
        role: "user",
        content: "Output validation failed:\nanswer rejected\nPlease fix the errors above.",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", name: "search", arguments: '{"query":"test"}' }],
      },
      { role: "tool", tool_call_id: "call_1", content: "tool result" },
      { role: "assistant", content: "final answer" },
    ]);
    expect(mock.calls.count()).toBe(3);
    // The final model call sees a coherent history: the tool-call turn is still
    // preceded by the validation feedback that prompted it.
    expect(mock.calls.last()?.messages).toEqual([
      { role: "assistant", content: "bad answer" },
      {
        role: "user",
        content: "Output validation failed:\nanswer rejected\nPlease fix the errors above.",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", name: "search", arguments: '{"query":"test"}' }],
      },
      { role: "tool", tool_call_id: "call_1", content: "tool result" },
    ]);
    expect(searchHandler).toHaveBeenCalledWith({ query: "test" });
  });

  it("preserves tool_call extra and message extra across tool loop turns", async () => {
    const mock = createMockModel();
    let observedSecondTurnMessages: Array<{
      role: string;
      tool_calls?: Array<{ extra?: Record<string, unknown> }>;
      extra?: Record<string, unknown>;
    }> | null = null;

    mock.sequence([
      {
        type: "tool_calls",
        calls: [
          {
            id: "call_1",
            name: "search",
            arguments: { query: "test" },
            extra: { thoughtSignature: "sig_1" },
          },
        ],
        extra: { traceId: "trace_1", safety: "low" },
      },
      {
        type: "custom",
        handler: async (payload) => {
          observedSecondTurnMessages = payload.messages as typeof observedSecondTurnMessages;
          return "final answer";
        },
      },
    ]);

    const agent = createAgent({
      id: "prompt_chat_extra",
      model: mock.adapter,
      handler: async () => {
        equipTool({
          name: "search",
          description: "Search for data",
          parameters: z.object({ query: z.string() }),
          handler: async () => ({ result: "ok" }),
        });
        return promptChat();
      },
    });

    const result = await agent({});

    expect(result.data).toBe("final answer");
    expect(mock.calls.count()).toBe(2);
    expect(observedSecondTurnMessages).not.toBeNull();

    const firstAssistantMessage = observedSecondTurnMessages!.find(
      (msg) =>
        msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
    );
    expect(firstAssistantMessage?.extra).toEqual({ traceId: "trace_1", safety: "low" });
    expect(firstAssistantMessage?.tool_calls?.[0]?.extra).toEqual({ thoughtSignature: "sig_1" });
  });
});
