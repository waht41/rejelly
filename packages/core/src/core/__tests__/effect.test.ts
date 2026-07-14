/**
 * Effect Callbacks Tests
 *
 * Tests for onStream
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import { createDeferred } from "../../utils/deferred";
import type { ModelAdapter, StreamEvent } from "../domain/model";
import type { AgentStreamEvent } from "../domain/stream";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { executeTurn } from "../engine/turn";
import { onStream } from "../facade/effect";
import { equipTool } from "../facade/equip/equip";
import { createAgentPolicy } from "../policy/prompt";
import { promptChat } from "../policy/prompt-chat";
import { promptAgent } from "../policy/prompt-schema";

describe("onStream", () => {
  function createStreamEventModel(events: StreamEvent[]): ModelAdapter {
    return {
      id: "stream-event-model",
      stream: async function* (): AsyncGenerator<StreamEvent> {
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  it("streams agent-level events across promptChat tool loop turns", async () => {
    const mock = createMockModel();
    mock.sequence([
      {
        type: "tool_calls",
        calls: [{ id: "call_1", name: "search", arguments: { query: "test" } }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        type: "text",
        content: "final answer",
        usage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
      },
    ]);

    const received: Array<{ type: string; turnIndex: number }> = [];

    const agent = createAgent({
      id: "stream_prompt_chat",
      model: mock.adapter,
      handler: async () => {
        equipTool({
          name: "search",
          description: "Search for data",
          parameters: z.object({ query: z.string() }),
          handler: async () => "ok",
        });
        onStream(async (stream) => {
          for await (const event of stream) {
            received.push({ type: event.type, turnIndex: event.turnIndex });
          }
        });
        return promptChat();
      },
    });

    const result = await agent({});

    expect(result.data).toBe("final answer");
    expect(received).toEqual(
      expect.arrayContaining([
        { type: "turn_start", turnIndex: 0 },
        { type: "tool_call_stream", turnIndex: 0 },
        { type: "usage", turnIndex: 0 },
        { type: "tool_call", turnIndex: 0 },
        { type: "turn_start", turnIndex: 1 },
        { type: "text", turnIndex: 1 },
        { type: "usage", turnIndex: 1 },
      ]),
    );
  });

  it("leaves main conversation stream events on the default channel", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenStream(['{"done":true}'])
      .withUsage({
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      });

    const received: AgentStreamEvent[] = [];

    const agent = createAgent({
      id: "stream_default_channel",
      model: mock.adapter,
      handler: async () => {
        onStream(async (stream) => {
          for await (const event of stream) {
            received.push(event);
          }
        });
        return promptAgent(schemas.done);
      },
    });

    await agent({});

    expect(received.length).toBeGreaterThan(0);
    expect(received.every((event) => event.channel === undefined)).toBe(true);
  });

  it("stamps named channels on all events emitted by a channelled turn", async () => {
    const received: AgentStreamEvent[] = [];
    const model = createStreamEventModel([
      { type: "reasoning", content: "thinking" },
      { type: "text", content: '{"done":true}' },
      { type: "extra", extra: { source: "compact" } },
      {
        type: "tool_call",
        toolCall: {
          index: 0,
          id: "call_1",
          name: "lookup",
          arguments: "{}",
        },
      },
      {
        type: "usage",
        usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
      },
      { type: "finish", finishReason: "tool_calls" },
    ]);

    const channelledPolicy = createAgentPolicy({
      policyId: "test-channelled-turn",
      handler: async (promptCtx) => {
        const result = await executeTurn([{ role: "user", content: "summarize" }], {
          runtime: promptCtx,
          channel: "context_compaction",
        });
        return result.message;
      },
    });

    const agent = createAgent({
      id: "stream_named_channel",
      model,
      handler: async () => {
        onStream(async (stream) => {
          for await (const event of stream) {
            received.push(event);
          }
        });

        return channelledPolicy();
      },
    });

    await agent({});

    expect(received.map((event) => event.type)).toEqual([
      "turn_start",
      "reasoning",
      "structured_data",
      "structured_data",
      "text",
      "extra",
      "structured_data",
      "tool_call_stream",
      "usage",
      "turn_done",
      "structured_data",
      "tool_call",
    ]);
    expect(received.every((event) => event.channel === "context_compaction")).toBe(true);
  });

  it("stamps named channels on stream errors", async () => {
    const failure = new Error("stream failed");
    const received: AgentStreamEvent[] = [];
    const model = createStreamEventModel([{ type: "error", error: failure }]);

    const channelledPolicy = createAgentPolicy({
      policyId: "test-channelled-turn-error",
      handler: async (promptCtx) => {
        await executeTurn([{ role: "user", content: "fail" }], {
          runtime: promptCtx,
          channel: "context_compaction",
        });
      },
    });

    const agent = createAgent({
      id: "stream_named_channel_error",
      model,
      handler: async () => {
        onStream(async (stream) => {
          for await (const event of stream) {
            received.push(event);
          }
        });

        await channelledPolicy();
      },
    });

    await expect(agent({})).rejects.toBe(failure);

    expect(received).toEqual([
      { type: "turn_start", turnIndex: 0, channel: "context_compaction" },
      { type: "error", turnIndex: 0, channel: "context_compaction", error: failure },
    ]);
  });

  it("supports multiple stream consumers", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(['{"value":"ok"}']);

    const first: string[] = [];
    const second: string[] = [];

    const agent = createAgent({
      id: "stream_multicast",
      model: mock.adapter,
      handler: async () => {
        onStream(async (stream) => {
          for await (const event of stream) {
            first.push(event.type);
          }
        });
        onStream(async (stream) => {
          for await (const event of stream) {
            second.push(event.type);
          }
        });
        return promptAgent(z.object({ value: z.string() }));
      },
    });

    await agent({});

    expect(first).toContain("text");
    expect(first).toContain("structured_data");
    expect(second).toContain("text");
    expect(second).toContain("structured_data");
  });

  it("emits structured_data events with progressive partial parsing", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(['{"name":"', "Alice", '"}']);

    const partialEvents: Array<{
      data: Partial<unknown>;
      isValid: boolean;
      status: "partial" | "complete" | "error";
    }> = [];

    const agent = createAgent({
      id: "stream_partial_data",
      model: mock.adapter,
      handler: async () => {
        onStream(
          async (stream) => {
            for await (const event of stream) {
              if (event.type === "structured_data") {
                partialEvents.push({
                  data: event.data,
                  isValid: event.isValid,
                  status: event.status,
                });
              }
            }
          },
          { awaitOnEnd: true },
        );
        return promptAgent(z.object({ name: z.string() }));
      },
    });

    const result = await agent({});

    expect(result.name).toBe("Alice");
    expect(partialEvents.length).toBeGreaterThan(0);
    expect(partialEvents[partialEvents.length - 1]).toEqual({
      data: { name: "Alice" },
      isValid: true,
      status: "complete",
    });
  });

  it("consumer error does not break model execution", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const normalConsumer = vi.fn();

    const agent = createAgent({
      id: "stream_consumer_error",
      model: mock.adapter,
      handler: async () => {
        onStream(
          async (stream) => {
            for await (const _event of stream) {
              throw new Error("stream consumer failed");
            }
          },
          { awaitOnEnd: true },
        );
        onStream(async (stream) => {
          for await (const event of stream) {
            normalConsumer(event.type);
          }
        });
        return promptAgent(z.object({ ok: z.boolean() }));
      },
    });

    const result = await agent({});

    expect(result.ok).toBe(true);
    expect(normalConsumer).toHaveBeenCalledWith("text");
    warnSpy.mockRestore();
  });

  it("binds stream consumers to generation lifecycle", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ done: true });

    const exits: number[] = [];
    let runCount = 0;

    const agent = createAgent({
      id: "stream_generation_lifecycle",
      model: mock.adapter,
      handler: async () => {
        const generationId = runCount;
        runCount += 1;

        onStream(async (stream) => {
          try {
            for await (const _event of stream) {
              // drain
            }
          } finally {
            exits.push(generationId);
          }
        });

        await promptAgent(schemas.done);

        if (generationId === 0) {
          return reborn();
        }
        return { done: true };
      },
    });

    const result = await agent({});

    expect(result.done).toBe(true);
    expect(exits).toEqual([0, 1]);
  });

  it("starts consumers before the first stream event so finally runs on immediate failure", async () => {
    const mock = createMockModel();
    const failure = new Error("network failed");
    mock.when(() => true).thenThrow(failure);

    const states: string[] = [];

    const agent = createAgent({
      id: "stream_immediate_failure",
      model: mock.adapter,
      handler: async () => {
        onStream(async (stream) => {
          try {
            states.push("started");
            for await (const _event of stream) {
              // no-op
            }
          } finally {
            states.push("closed");
          }
        });

        return promptAgent(schemas.done);
      },
    });

    await expect(agent({})).rejects.toBe(failure);
    expect(states).toEqual(["started", "closed"]);
  });

  it("supports user-provided cancellation signal", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(['{"done":true}']);

    const controller = new AbortController();
    const received: string[] = [];

    const agent = createAgent({
      id: "stream_user_signal",
      model: mock.adapter,
      handler: async () => {
        onStream(
          async (stream) => {
            for await (const event of stream) {
              received.push(event.type);
              controller.abort("stop");
            }
          },
          { signal: controller.signal },
        );

        return promptAgent(schemas.done);
      },
    });

    const result = await agent({});

    expect(result.done).toBe(true);
    expect(received).toContain("text");
  });

  it("waits for consumer completion by default", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(['{"done":true}']);

    const release = createDeferred<void>();
    let settled = false;

    const agent = createAgent({
      id: "stream_wait_default",
      model: mock.adapter,
      handler: async () => {
        onStream(async (stream) => {
          for await (const _event of stream) {
            // drain
          }
          await release.promise;
          settled = true;
        });

        return promptAgent(schemas.done);
      },
    });

    const agentPromise = agent({});
    await Promise.resolve();
    expect(settled).toBe(false);

    release.resolve();
    const result = await agentPromise;
    expect(result.done).toBe(true);
    expect(settled).toBe(true);
  });

  it("does not wait for consumer completion when awaitOnEnd is false", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(['{"done":true}']);

    const release = createDeferred<void>();
    let settled = false;

    const agent = createAgent({
      id: "stream_no_wait_on_end",
      model: mock.adapter,
      handler: async () => {
        onStream(
          async (stream) => {
            for await (const _event of stream) {
              // drain
            }
            await release.promise;
            settled = true;
          },
          { awaitOnEnd: false },
        );

        return promptAgent(schemas.done);
      },
    });

    const result = await agent({});
    expect(result.done).toBe(true);
    expect(settled).toBe(false);

    release.resolve();
  });

  it("does not warn for non-awaited consumer failures", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = createAgent({
      id: "stream_non_awaited_error",
      model: mock.adapter,
      handler: async () => {
        onStream(
          async (stream) => {
            for await (const _event of stream) {
              throw new Error("ignored failure");
            }
          },
          { awaitOnEnd: false },
        );

        return promptAgent(z.object({ ok: z.boolean() }));
      },
    });

    const result = await agent({});
    expect(result.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
