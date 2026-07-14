/**
 * Tool tests
 *
 * Observes tool execution via mock model and handler spies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import {
  InvalidPromptRuntimeError,
  InvalidToolOutputError,
  isInvalidPromptRuntimeError,
  ToolLoopExceededError,
  TurnBudgetExceededError,
} from "../domain/errors";
import {
  EVENTS,
  type ToolsExecuteEndEvent,
  type ToolsExecuteStartEvent,
  type TraceEvent,
} from "../domain/events";
import type { ModelAdapter, ModelStreamOptions, StreamEvent } from "../domain/model";
import { type ToolDefinition, type ToolMiddleware, toolContent } from "../domain/tool";
import { createAgent } from "../engine/agent";
import { callTool, executeTools } from "../engine/tool-executor";
import { executeTurn } from "../engine/turn";
import { equipTool } from "../facade/equip/equip";
import { runWith } from "../facade/run";
import { getGlobalEventBus, resetEventBus } from "../observability/event-bus";
import { createAgentPolicy, type PromptContext } from "../policy/prompt";
import { promptAgent } from "../policy/prompt-schema";
import { dumpSnapshot } from "../snapshot/dump";
import type { AgentSnapshot } from "../snapshot/type";

describe("Tool", () => {
  function createTool(name: string): ToolDefinition {
    return {
      name,
      description: `${name} tool`,
      parameters: z.object({}),
      handler: async () => null,
    };
  }

  function createToolSpyModel(seenTools: Array<string[] | undefined>): ModelAdapter {
    return {
      id: "tool-spy-model",
      stream: async function* (
        _messages,
        options?: ModelStreamOptions,
      ): AsyncGenerator<StreamEvent> {
        seenTools.push(options?.tools?.map((tool) => tool.name));
        yield { type: "text", content: "ok" };
      },
    };
  }

  describe("executeTurn runtime tools", () => {
    it("base runtime carries tools equipped before the policy barrier", async () => {
      const seenTools: Array<string[] | undefined> = [];
      const policy = createAgentPolicy({
        policyId: "test-turn-base-tools",
        handler: async (promptCtx) => {
          const result = await executeTurn([{ role: "user", content: "hello" }], {
            runtime: promptCtx,
          });
          return result.message.content;
        },
      });
      const agent = createAgent({
        id: "execute_turn_default_tools",
        model: createToolSpyModel(seenTools),
        handler: async () => {
          equipTool(createTool("default_tool"));
          return policy();
        },
      });

      await agent({});

      expect(seenTools).toEqual([["default_tool"]]);
    });

    it("uses forked runtime tools instead of base tools", async () => {
      const seenTools: Array<string[] | undefined> = [];
      const policy = createAgentPolicy({
        policyId: "test-turn-fork-tools",
        handler: async (promptCtx) => {
          const result = await executeTurn([{ role: "user", content: "hello" }], {
            runtime: promptCtx.fork({ tools: [createTool("runtime_tool")] }),
          });
          return result.message.content;
        },
      });
      const agent = createAgent({
        id: "execute_turn_runtime_tools",
        model: createToolSpyModel(seenTools),
        handler: async () => {
          equipTool(createTool("default_tool"));
          return policy();
        },
      });

      await agent({});

      expect(seenTools).toEqual([["runtime_tool"]]);
    });

    it("executes tool calls against the provided runtime tools", async () => {
      const runtimeHandler = vi.fn().mockResolvedValue("runtime ok");
      const draftHandler = vi.fn().mockResolvedValue("draft ok");
      const policy = createAgentPolicy({
        policyId: "test-tools-fork-tools",
        handler: async (promptCtx) =>
          executeTools([{ id: "call_1", name: "runtime_tool", arguments: "{}" }], {
            runtime: promptCtx.fork({
              tools: [
                {
                  ...createTool("runtime_tool"),
                  handler: runtimeHandler,
                },
              ],
            }),
          }),
      });
      const agent = createAgent({
        id: "execute_tools_runtime_tools",
        model: createToolSpyModel([]),
        handler: async () => {
          equipTool({
            ...createTool("draft_tool"),
            handler: draftHandler,
          });

          return policy();
        },
      });

      const result = await agent({});

      expect(result).toEqual([
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "runtime ok",
        },
      ]);
      expect(runtimeHandler).toHaveBeenCalledTimes(1);
      expect(draftHandler).not.toHaveBeenCalled();
    });

    it("preserves typed multimodal tool content as message content", async () => {
      const policy = createAgentPolicy({
        policyId: "test-tools-multimodal",
        handler: async (promptCtx) =>
          executeTools([{ id: "call_1", name: "read_img", arguments: "{}" }], {
            runtime: promptCtx.fork({
              tools: [
                {
                  name: "read_img",
                  description: "Read image",
                  parameters: z.object({}),
                  handler: async () =>
                    toolContent([
                      { type: "text", text: "Image loaded." },
                      {
                        type: "image",
                        image: { url: "data:image/png;base64,AAAA", detail: "low" },
                      },
                    ]),
                },
              ],
            }),
          }),
      });
      const agent = createAgent({
        id: "execute_tools_multimodal_tool_content",
        model: createToolSpyModel([]),
        handler: async () => policy(),
      });

      const result = await agent({});

      expect(result).toEqual([
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "Image loaded." },
            {
              type: "image",
              image: { url: "data:image/png;base64,AAAA", detail: "low" },
            },
          ],
        },
      ]);
    });

    it("reserves turn budget before awaiting when executeTurn calls fan out", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      mock.setDefaultDelay(20);

      const policy = createAgentPolicy({
        policyId: "test-turn-parallel-budget",
        handler: async (promptCtx) =>
          Promise.allSettled([
            executeTurn([{ role: "user", content: "first" }], { runtime: promptCtx }),
            executeTurn([{ role: "user", content: "second" }], { runtime: promptCtx }),
            executeTurn([{ role: "user", content: "third" }], { runtime: promptCtx }),
          ]),
      });
      const agent = createAgent({
        id: "execute_turn_parallel_budget",
        model: mock.adapter,
        maxTurnSteps: 2,
        handler: async () => policy(),
      });

      const results = await agent({});

      expect(results.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "rejected",
      ]);
      const third = results[2];
      expect(third.status).toBe("rejected");
      if (third.status !== "rejected") {
        throw new Error("expected third executeTurn result to be rejected");
      }
      expect(third.reason).toBeInstanceOf(TurnBudgetExceededError);
      expect((third.reason as TurnBudgetExceededError).actualTurns).toBe(2);
      expect(mock.calls.count()).toBe(2);
    });
  });

  describe("execution primitives are policy-internal (runtime seal)", () => {
    it("rejects a call without runtime (untyped caller)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      const bareExecuteTurn = executeTurn as unknown as (messages: unknown) => Promise<unknown>;
      const policy = createAgentPolicy({
        policyId: "test-seal-missing",
        handler: async () => bareExecuteTurn([{ role: "user", content: "hello" }]),
      });
      const agent = createAgent({
        id: "seal_missing",
        model: mock.adapter,
        handler: async () => policy(),
      });

      const failure = await agent({}).then(
        () => null,
        (error: unknown) => error,
      );

      expect(isInvalidPromptRuntimeError(failure)).toBe(true);
      expect(failure).toMatchObject({ apiName: "executeTurn", reason: "missing" });
      expect(mock.calls.count()).toBe(0);
    });

    it("rejects a hand-built runtime (unsealed)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      const policy = createAgentPolicy({
        policyId: "test-seal-unsealed",
        handler: async () =>
          executeTools([{ id: "call_1", name: "noop", arguments: "{}" }], {
            runtime: {
              messages: [],
              system: [],
              instruction: [],
              tools: [],
              toolCallLoopMiddlewares: [],
            },
          }),
      });
      const agent = createAgent({
        id: "seal_unsealed",
        model: mock.adapter,
        handler: async () => policy(),
      });

      await expect(agent({})).rejects.toMatchObject({
        name: "InvalidPromptRuntimeError",
        apiName: "executeTools",
        reason: "unsealed",
      });
    });

    it("rejects a runtime that outlived its policy (expired) — bare handler calls included", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      let smuggled: PromptContext | undefined;
      const policy = createAgentPolicy({
        policyId: "test-seal-expired",
        handler: async (promptCtx) => {
          smuggled = promptCtx;
          const result = await executeTurn([{ role: "user", content: "hello" }], {
            runtime: promptCtx,
          });
          return result.message.content;
        },
      });
      const agent = createAgent({
        id: "seal_expired",
        model: mock.adapter,
        handler: async () => {
          await policy();
          // A bare call from the handler after the policy returned must be rejected,
          // even though it presents a runtime that was live moments ago.
          return executeTurn([{ role: "user", content: "again" }], { runtime: smuggled! });
        },
      });

      await expect(agent({})).rejects.toBeInstanceOf(InvalidPromptRuntimeError);
      await expect(
        createAgent({
          id: "seal_expired_reason",
          model: mock.adapter,
          handler: async () =>
            executeTurn([{ role: "user", content: "again" }], { runtime: smuggled! }),
        })({}),
      ).rejects.toMatchObject({ reason: "expired" });
      expect(mock.calls.count()).toBe(1);
    });

    it("rejects a live runtime smuggled into another generation (foreign)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      let smuggled: PromptContext | undefined;
      const child = createAgent({
        id: "seal_foreign_child",
        model: mock.adapter,
        handler: async () =>
          executeTurn([{ role: "user", content: "child" }], { runtime: smuggled! }),
      });
      const policy = createAgentPolicy({
        policyId: "test-seal-foreign",
        handler: async (promptCtx) => {
          // Parent policy is still running, so the seal is alive — the owner
          // check alone must reject it inside the child generation.
          smuggled = promptCtx;
          return child({});
        },
      });
      const parent = createAgent({
        id: "seal_foreign_parent",
        model: mock.adapter,
        handler: async () => policy(),
      });

      await expect(parent({})).rejects.toMatchObject({
        name: "InvalidPromptRuntimeError",
        apiName: "executeTurn",
        reason: "foreign",
      });
    });

    it("accepts a spread-derived runtime (same seal reference, same policy execution)", async () => {
      const seenTools: Array<string[] | undefined> = [];
      const policy = createAgentPolicy({
        policyId: "test-seal-spread",
        handler: async (promptCtx) => {
          const derived = { ...promptCtx, tools: [createTool("spread_tool")] };
          const result = await executeTurn([{ role: "user", content: "hello" }], {
            runtime: derived,
          });
          return result.message.content;
        },
      });
      const agent = createAgent({
        id: "seal_spread",
        model: createToolSpyModel(seenTools),
        handler: async () => policy(),
      });

      await agent({});

      expect(seenTools).toEqual([["spread_tool"]]);
    });
  });

  describe("agent normal tool call, multi-turn, parallel tools", () => {
    it("single tool call then final content", async () => {
      const mock = createMockModel();
      const searchHandler = vi.fn().mockResolvedValue({ results: ["a", "b"] });

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "search", arguments: { query: "test" } }]);
      mock.setDefaultResponse({ answer: "found" });

      const agent = createAgent({
        id: "e2e_single_tool",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "search",
            description: "Search for data",
            parameters: z.object({ query: z.string() }),
            handler: searchHandler,
          });
          return promptAgent(z.object({ answer: z.string() }));
        },
      });

      const result = await agent({});

      expect(searchHandler).toHaveBeenCalledTimes(1);
      expect(searchHandler).toHaveBeenCalledWith({ query: "test" });
      expect(result).toEqual({ answer: "found" });
      expect(mock.calls.count()).toBe(2); // turn1: tool_call, turn2: content
    });

    it("multiple tools in parallel in one turn", async () => {
      const mock = createMockModel();
      const order: string[] = [];
      const slowHandler = vi.fn().mockImplementation(async () => {
        order.push("slow_start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("slow_end");
        return "slow";
      });
      const fastHandler = vi.fn().mockImplementation(async () => {
        order.push("fast_start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("fast_end");
        return "fast";
      });

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([
          { id: "call_1", name: "slow", arguments: {} },
          { id: "call_2", name: "fast", arguments: {} },
        ]);
      mock.setDefaultResponse({ done: true });

      const agent = createAgent({
        id: "e2e_parallel_tools",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "slow",
            description: "Slow",
            parameters: z.object({}),
            handler: slowHandler,
          });
          equipTool({
            name: "fast",
            description: "Fast",
            parameters: z.object({}),
            handler: fastHandler,
          });
          return promptAgent(schemas.done);
        },
      });

      const result = await agent({});

      expect(slowHandler).toHaveBeenCalledTimes(1);
      expect(fastHandler).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ done: true });
      expect(order).toEqual(["slow_start", "fast_start", "fast_end", "slow_end"]);
    });

    it("multiple turns: LLM returns tool_call -> framework runs tools -> next turn; until LLM returns content then promptAgent ends", async () => {
      const mock = createMockModel();
      const getHandler = vi.fn().mockResolvedValue("data");
      const formatHandler = vi.fn().mockResolvedValue("formatted");

      // Turn 1: LLM returns native tool_call get_data -> framework runs tool, appends result to messages
      // Turn 2: LLM sees tool result, returns tool_call format -> framework runs tool
      // Turn 3: LLM sees format result, returns content (schema) -> promptAgent finishes, returns contractual output
      // Mock records current call before matching, so first stream() has count 1, second has 2, third has 3.
      mock
        .when(() => mock.calls.count() === 1)
        .thenCallTools([{ id: "call_1", name: "get_data", arguments: {} }]);
      mock
        .when(() => mock.calls.count() === 2)
        .thenCallTools([{ id: "call_2", name: "format", arguments: { text: "data" } }]);
      mock.setDefaultResponse({ summary: "ok" });

      const agent = createAgent({
        id: "e2e_multi_turn",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "get_data",
            description: "Get data",
            parameters: z.object({}),
            handler: getHandler,
          });
          equipTool({
            name: "format",
            description: "Format",
            parameters: z.object({ text: z.string() }),
            handler: formatHandler,
          });
          return promptAgent(z.object({ summary: z.string() }));
        },
      });

      const result = await agent({});

      expect(getHandler).toHaveBeenCalledTimes(1);
      expect(formatHandler).toHaveBeenCalledTimes(1);
      expect(formatHandler).toHaveBeenCalledWith({ text: "data" });
      expect(result).toEqual({ summary: "ok" });
      expect(mock.calls.count()).toBe(3); // turn1 tool_call, turn2 tool_call, turn3 content
    });
  });

  describe("turn limit and tool error", () => {
    it("throws ToolLoopExceededError when maxTurnSteps exceeded", async () => {
      const mock = createMockModel();
      const handler = vi.fn().mockResolvedValue("ok");

      mock.when(() => true).thenCallTools([{ id: "call_loop", name: "loop", arguments: {} }]);

      const agent = createAgent({
        id: "e2e_loop_limit",
        model: mock.adapter,
        maxTurnSteps: 3,
        maxRetries: 0,
        handler: async () => {
          equipTool({
            name: "loop",
            description: "Loop",
            parameters: z.object({}),
            handler,
          });
          return promptAgent(schemas.simple);
        },
      });

      let err: unknown;
      try {
        await agent({});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ToolLoopExceededError);
      expect((err as ToolLoopExceededError).maxTurnSteps).toBe(3);
      expect((err as ToolLoopExceededError).actualTurns).toBe(3);
      expect(handler).toHaveBeenCalledTimes(2); // last time while not been called to avoid waste
    });

    it("tool handler returns undefined: callTool throws InvalidToolOutputError", async () => {
      await expect(
        callTool(
          {
            name: "broken",
            description: "Broken",
            parameters: z.object({}),
            handler: async () => undefined,
          },
          {},
        ),
      ).rejects.toBeInstanceOf(InvalidToolOutputError);
    });

    it("tool handler throws: error message passed to next turn, agent can recover", async () => {
      const mock = createMockModel();

      // First turn: no tool result yet, match and return tool call
      mock
        .when((payload) => !payload.messages.some((m) => m.role === "tool"))
        .thenCallTools([{ id: "call_1", name: "broken", arguments: {} }]);
      mock.setDefaultResponse({ recovered: true });

      const agent = createAgent({
        id: "e2e_tool_throws",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "broken",
            description: "Broken",
            parameters: z.object({}),
            handler: async () => {
              throw new Error("Tool crashed");
            },
          });
          return promptAgent(z.object({ recovered: z.boolean() }));
        },
      });

      const result = await agent({});

      expect(result.recovered).toBe(true);

      const allCalls = mock.calls.all();
      expect(allCalls.length).toBeGreaterThanOrEqual(2);

      const secondCallMessages = allCalls[1].messages;
      const toolMsg = secondCallMessages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(String(toolMsg?.content)).toContain("Tool crashed");
      expect(String(toolMsg?.content)).toContain("error");
    });

    it("tool handler returns undefined: error message passed to next turn, agent can recover", async () => {
      const mock = createMockModel();

      mock
        .when((payload) => !payload.messages.some((m) => m.role === "tool"))
        .thenCallTools([{ id: "call_1", name: "broken", arguments: {} }]);
      mock.setDefaultResponse({ recovered: true });

      const agent = createAgent({
        id: "e2e_tool_invalid_output",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "broken",
            description: "Broken",
            parameters: z.object({}),
            handler: async () => undefined,
          });
          return promptAgent(z.object({ recovered: z.boolean() }));
        },
      });

      const result = await agent({});

      expect(result.recovered).toBe(true);

      const allCalls = mock.calls.all();
      expect(allCalls.length).toBeGreaterThanOrEqual(2);

      const secondCallMessages = allCalls[1].messages;
      const toolMsg = secondCallMessages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(String(toolMsg?.content)).toContain(InvalidToolOutputError.name);
      expect(String(toolMsg?.content)).toContain("undefined");
      expect(String(toolMsg?.content)).toContain("JSON-serializable");
    });
  });

  describe("callTool", () => {
    beforeEach(() => resetEventBus());
    afterEach(() => resetEventBus());

    it("runs the tool's own middleware chain around the handler", async () => {
      const order: string[] = [];
      const wrap: ToolMiddleware = {
        name: "wrap",
        handler: async (_ctx, next) => {
          order.push("before");
          const result = await next();
          order.push("after");
          return `[wrapped] ${result}`;
        },
      };
      const handler = vi.fn().mockResolvedValue("raw");

      const output = await callTool(
        {
          name: "greet",
          description: "Greet",
          parameters: z.object({ name: z.string() }),
          handler,
          middlewares: [wrap],
        },
        { name: "ada" },
      );

      expect(handler).toHaveBeenCalledWith({ name: "ada" });
      expect(order).toEqual(["before", "after"]);
      // Returns the handler shape as seen through the middleware chain
      expect(output).toBe("[wrapped] raw");
    });

    it("emits tools execute start/end events carrying the tool result", async () => {
      const collected: TraceEvent[] = [];
      getGlobalEventBus().subscribe("*", (event) => collected.push(event));

      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const agent = createAgent({
        id: "standalone_events",
        model: mock.adapter,
        handler: async () => {
          await callTool(
            {
              name: "ping",
              description: "Ping",
              parameters: z.object({}),
              handler: async () => "pong",
            },
            {},
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      const startEvents = collected.filter(
        (e) => e.type === EVENTS.TOOLS_EXECUTE_START,
      ) as ToolsExecuteStartEvent[];
      const endEvents = collected.filter(
        (e) => e.type === EVENTS.TOOLS_EXECUTE_END,
      ) as ToolsExecuteEndEvent[];
      const start = startEvents.find((e) => e.toolNames.includes("ping"));
      const end = endEvents.find((e) => e.toolNames.includes("ping"));

      expect(start).toBeDefined();
      expect(end).toBeDefined();
      expect(end!.success).toBe(true);
      expect(end!.successCount).toBe(1);
      expect(end!.toolResults).toHaveLength(1);
      expect(end!.toolResults[0]).toMatchObject({
        toolName: "ping",
        output: "pong",
        success: true,
      });
    });

    it("reuses the journaled tool output on snapshot replay (cache hit)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const handler = vi.fn().mockResolvedValue({ value: 42 });
      const tool: ToolDefinition = {
        name: "compute",
        description: "Compute",
        parameters: z.object({ x: z.number() }),
        handler,
      };

      let snapshot: AgentSnapshot | null = null;

      const agent = createAgent({
        id: "standalone_cache",
        model: mock.adapter,
        handler: async () => {
          await callTool(tool, { x: 1 });
          snapshot = dumpSnapshot();
          return promptAgent(schemas.simple);
        },
      });

      await agent({});
      expect(handler).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toBeNull();

      handler.mockClear();

      let cachedOutput: unknown;
      await runWith(
        async () => {
          const restored = createAgent({
            id: "standalone_cache",
            model: mock.adapter,
            handler: async () => {
              cachedOutput = await callTool(tool, { x: 1 });
              return promptAgent(schemas.simple);
            },
          });
          return restored({});
        },
        { snapshot: snapshot! },
      );

      // Same tool + args → same contentHash → journal cache hit, handler skipped
      expect(handler).not.toHaveBeenCalled();
      expect(cachedOutput).toEqual({ value: 42 });
    });
  });
});
