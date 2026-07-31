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
import { COMPACTION_STREAM_CHANNEL } from "../../shared/contracts/streamChannels";
import type { EvilJellyHostBindings, RuntimePhase } from "../../shared/types";
import { setBinding } from "./hostBindings";
import { phaseForStreamEvent, useStandardStreaming } from "./standardStreaming";

function createTestBindings(output: string[], phases: RuntimePhase[] = []): EvilJellyHostBindings {
  return {
    getInput: async () => ({ text: "" }),
    printOut: (message) => output.push(message),
    logUserMessage: () => {},
    logAssistantMessage: () => {},
    logToolBlock: () => {},
    logSystemEvent: () => {},
    onPhaseUpdate: (phase) => phases.push(phase),
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

  it("reports the request wait, the reply, and the turn end as distinct phases", async () => {
    const output: string[] = [];
    const phases: RuntimePhase[] = [];
    const model = createStreamingModel(() => [
      { type: "text", content: "plain " },
      { type: "text", content: "assistant text" },
      { type: "finish", finishReason: "stop" },
    ]);

    const agent = createAgent({
      id: "standard-streaming-phases",
      model,
      handler: async () => {
        await setBinding(createTestBindings(output, phases));
        useStandardStreaming({ textMode: "plain" });
        return promptChat({ message: [{ role: "user", content: "hi" }] });
      },
    });

    await agent({});

    // Two text deltas, one "streaming": a phase change per delta would hammer the UI store and
    // rebase the elapsed timer on every chunk, which is exactly what the counter must not do.
    expect(phases).toEqual(["connecting", "streaming", "working"]);
  });
});

describe("phaseForStreamEvent", () => {
  const midTurn = { modelSpoke: false, turnEnded: false };

  it("gives the wait before the model's first event a phase of its own", () => {
    // Without it a stalled connection is indistinguishable from a slow model: both are a blank
    // screen until the SDK finally gives up.
    expect(phaseForStreamEvent({ type: "turn_start" }, midTurn)).toBe("connecting");
    expect(phaseForStreamEvent({ type: "text", delta: "hi" }, midTurn)).toBe("streaming");
    expect(phaseForStreamEvent({ type: "turn_done" }, { modelSpoke: true, turnEnded: false })).toBe(
      "working",
    );
  });

  it("treats only leading reasoning as thinking", () => {
    expect(phaseForStreamEvent({ type: "reasoning", delta: "hmm" }, midTurn)).toBe("thinking");
    // Interleaving models emit reasoning after the answer too; flapping back to "thinking" there
    // would restart the timer mid-reply.
    expect(
      phaseForStreamEvent(
        { type: "reasoning", delta: "hmm" },
        { modelSpoke: true, turnEnded: false },
      ),
    ).toBeNull();
  });

  it("ignores empty text deltas", () => {
    expect(phaseForStreamEvent({ type: "text", delta: "" }, midTurn)).toBeNull();
  });

  it("ignores the final structured snapshot that lands after the turn ended", () => {
    // The engine emits one last complete-parse snapshot after turn_done; reading it as fresh
    // output would flip the line back to "Responding" and restart the timer on a finished turn.
    const ended = { modelSpoke: true, turnEnded: true };
    expect(phaseForStreamEvent({ type: "structured_data" }, ended)).toBeNull();
    expect(phaseForStreamEvent({ type: "structured_data" }, midTurn)).toBe("streaming");
  });

  it("surfaces the compaction side-turn even though its output stays hidden", () => {
    expect(
      phaseForStreamEvent({ type: "turn_start", channel: COMPACTION_STREAM_CHANNEL }, midTurn),
    ).toBe("compacting");
    expect(
      phaseForStreamEvent({ type: "turn_done", channel: COMPACTION_STREAM_CHANNEL }, midTurn),
    ).toBe("working");
    // Its text is an internal handoff, so it must not read as the model answering.
    expect(
      phaseForStreamEvent(
        { type: "text", delta: "summary", channel: COMPACTION_STREAM_CHANNEL },
        midTurn,
      ),
    ).toBeNull();
  });

  it("leaves the phase alone for a side-turn it cannot name", () => {
    // An unrecognized channel belongs to some future internal turn; labelling it "compacting"
    // would be a wrong answer rather than a missing one.
    expect(
      phaseForStreamEvent({ type: "turn_start", channel: "some-future-turn" }, midTurn),
    ).toBeNull();
    expect(
      phaseForStreamEvent({ type: "turn_done", channel: "some-future-turn" }, midTurn),
    ).toBeNull();
  });
});
