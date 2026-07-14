import {
  createAgent,
  equipTool,
  type Message,
  type ModelAdapter,
  type ModelStreamOptions,
  promptChat,
  type StreamEvent,
} from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EvilJellyHostBindings } from "../../shared/types";
import { setBinding } from "./hostBindings";
import { useStandardStreaming } from "./standardStreaming";

function createTestBindings(output: string[]): EvilJellyHostBindings {
  return {
    getInput: async () => ({ text: "" }),
    printOut: (message) => output.push(message),
    logUserMessage: () => {},
    logAssistantMessage: () => {},
    logToolBlock: () => {},
    logSystemEvent: () => {},
    confirmTool: async () => ({ action: "accept" }),
    requestChoice: async (_message, options) => options[0]?.value ?? "",
  };
}

function createStreamingModel(
  streamForCall: (
    callIndex: number,
    messages: Message[],
    options?: ModelStreamOptions,
  ) => StreamEvent[],
): ModelAdapter {
  let callIndex = 0;
  return {
    id: "standard-streaming-test-model",
    async *stream(messages, options) {
      const events = streamForCall(callIndex, messages, options);
      callIndex += 1;
      for (const event of events) {
        yield event;
      }
    },
  };
}

const AnswerSchema = z.object({
  type: z.literal("answer"),
  reply: z.string(),
});

describe("useStandardStreaming", () => {
  it("streams only the requested structured field and does not leak raw JSON", async () => {
    const output: string[] = [];
    const model = createStreamingModel(() => [
      { type: "text", content: '{"type":"answer",' },
      { type: "text", content: '"reply":"Hello"}' },
      { type: "finish", finishReason: "stop" },
    ]);

    const agent = createAgent({
      id: "standard-streaming-structured",
      model,
      handler: async () => {
        await setBinding(createTestBindings(output));
        useStandardStreaming("reply");
        return promptChat({ message: [{ role: "user", content: "hi" }], schema: AnswerSchema });
      },
    });

    const result = await agent({});

    expect(result.data).toEqual({ type: "answer", reply: "Hello" });
    expect(output.join("")).toBe("Hello\n");
    expect(output.join("")).not.toContain('"type"');
    expect(output.join("")).not.toContain('"reply"');
  });

  it("does not print plain text turns unconditionally", async () => {
    const output: string[] = [];
    const model = createStreamingModel(() => [
      { type: "text", content: "plain assistant text" },
      { type: "finish", finishReason: "stop" },
    ]);

    const agent = createAgent({
      id: "standard-streaming-plain-text",
      model,
      handler: async () => {
        await setBinding(createTestBindings(output));
        useStandardStreaming("reply");
        return promptChat({ message: [{ role: "user", content: "hi" }] });
      },
    });

    const result = await agent({});

    expect(result.data).toBe("plain assistant text");
    expect(output).toEqual([]);
  });

  it("prints plain text turns when plain text mode is enabled", async () => {
    const output: string[] = [];
    const model = createStreamingModel(() => [
      { type: "text", content: "plain " },
      { type: "text", content: "assistant text" },
      { type: "finish", finishReason: "stop" },
    ]);

    const agent = createAgent({
      id: "standard-streaming-plain-text-enabled",
      model,
      handler: async () => {
        await setBinding(createTestBindings(output));
        useStandardStreaming({ textMode: "plain" });
        return promptChat({ message: [{ role: "user", content: "hi" }] });
      },
    });

    const result = await agent({});

    expect(result.data).toBe("plain assistant text");
    expect(output.join("")).toBe("plain assistant text\n");
  });

  it("delays text in tool-call turns without duplicating tool logger output", async () => {
    const output: string[] = [];
    const model = createStreamingModel((callIndex) =>
      callIndex === 0
        ? [
            { type: "text", content: "I will inspect the workspace." },
            {
              type: "tool_call",
              toolCall: {
                index: 0,
                id: "call_1",
                name: "lookup",
                arguments: '{"query":"workspace"}',
              },
            },
            { type: "finish", finishReason: "tool_calls" },
          ]
        : [
            { type: "text", content: '{"type":"answer","reply":"Done"}' },
            { type: "finish", finishReason: "stop" },
          ],
    );

    const agent = createAgent({
      id: "standard-streaming-tool-preamble",
      model,
      handler: async () => {
        await setBinding(createTestBindings(output));
        equipTool({
          name: "lookup",
          description: "Lookup test data.",
          parameters: z.object({ query: z.string() }),
          handler: async () => "lookup result",
        });
        useStandardStreaming("reply");
        return promptChat({ message: [{ role: "user", content: "hi" }], schema: AnswerSchema });
      },
    });

    const result = await agent({});

    expect(result.data).toEqual({ type: "answer", reply: "Done" });
    expect(output.join("")).toBe("I will inspect the workspace.\n\nDone\n");
  });
});
