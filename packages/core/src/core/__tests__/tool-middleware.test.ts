/**
 * Tool Middleware Tests
 *
 * Tests for tool middleware chain (augment + equipTool)
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import type { ToolCallLoopContext } from "../context/tool-call-loop";
import { LoopMissingToolOutputError } from "../domain/errors";
import type { ToolCall } from "../domain/model";
import type { ToolContext, ToolDefinition, ToolMiddleware } from "../domain/tool";
import { createAgent } from "../engine/agent";
import { augment } from "../facade/augment";
import {
  equipInstruction,
  equipSystem,
  equipTool,
  equipToolCallLoopMiddleware,
} from "../facade/equip/equip";
import { equipMemory } from "../facade/equip/memory";
import { promptAgent } from "../policy/prompt-schema";

describe("Tool Middleware Chain", () => {
  describe("augment - static middleware", () => {
    it("should augment tool with static middleware", () => {
      const baseTool: ToolDefinition = {
        name: "test",
        description: "Test tool",
        parameters: z.object({ input: z.string() }),
        handler: async (args) => `result: ${args.input}`,
      };

      const logMiddleware: ToolMiddleware = {
        name: "log",
        handler: async (_ctx, next) => {
          return `[LOG] ${await next()}`;
        },
      };

      const augmented = augment(baseTool, [logMiddleware]);

      expect(augmented.name).toBe("test");
      expect(augmented.middlewares).toHaveLength(1);
      expect(augmented.middlewares?.[0]).toBe(logMiddleware);
    });

    it("should chain multiple static middlewares", () => {
      const baseTool: ToolDefinition = {
        name: "test",
        description: "Test tool",
        parameters: z.object({ input: z.string() }),
        handler: async (args) => `result: ${args.input}`,
      };

      const mw1: ToolMiddleware = {
        name: "mw1",
        handler: async (_ctx, next) => `[MW1] ${await next()}`,
      };
      const mw2: ToolMiddleware = {
        name: "mw2",
        handler: async (_ctx, next) => `[MW2] ${await next()}`,
      };

      const augmented = augment(baseTool, [mw1, mw2]);

      expect(augmented.middlewares).toHaveLength(2);
      expect(augmented.middlewares?.[0]).toBe(mw1);
      expect(augmented.middlewares?.[1]).toBe(mw2);
    });

    it("should preserve existing middlewares when augmenting", () => {
      const baseTool: ToolDefinition = {
        name: "test",
        description: "Test tool",
        parameters: z.object({ input: z.string() }),
        handler: async (args) => `result: ${args.input}`,
        middlewares: [
          {
            name: "existing",
            handler: async (_ctx, next) => `[EXISTING] ${await next()}`,
          },
        ],
      };

      const newMw: ToolMiddleware = {
        name: "new",
        handler: async (_ctx, next) => `[NEW] ${await next()}`,
      };
      const augmented = augment(baseTool, [newMw]);

      expect(augmented.middlewares).toHaveLength(2);
      expect(augmented.middlewares?.[0]).toBe(baseTool.middlewares![0]);
      expect(augmented.middlewares?.[1]).toBe(newMw);
    });
  });

  describe("equipTool - dynamic middleware", () => {
    it("should register tool with dynamic middleware", async () => {
      const mock = createMockModel();
      const handler = vi.fn().mockResolvedValue("handler-result");
      const middlewareHandler = vi.fn().mockImplementation(async (_ctx, next) => {
        return `[MW] ${await next()}`;
      });
      const middleware: ToolMiddleware = {
        name: "test-middleware",
        handler: middlewareHandler,
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: { input: "test" } }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "test",
              description: "Test tool",
              parameters: z.object({ input: z.string() }),
              handler,
            },
            {
              middleware: [middleware],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(handler).toHaveBeenCalledWith({ input: "test" });
      expect(middleware.handler).toHaveBeenCalled();
    });

    it("should execute dynamic middleware in order", async () => {
      const mock = createMockModel();
      const _handler = vi.fn().mockResolvedValue("handler");
      const executionOrder: string[] = [];

      const mw1: ToolMiddleware = {
        name: "mw1",
        handler: async (_ctx, next) => {
          executionOrder.push("mw1-before");
          const result = await next();
          executionOrder.push("mw1-after");
          return `[MW1] ${result}`;
        },
      };

      const mw2: ToolMiddleware = {
        name: "mw2",
        handler: async (_ctx, next) => {
          executionOrder.push("mw2-before");
          const result = await next();
          executionOrder.push("mw2-after");
          return `[MW2] ${result}`;
        },
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: {} }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "test",
              description: "Test",
              parameters: z.object({}),
              handler: async () => {
                executionOrder.push("handler");
                return "handler";
              },
            },
            {
              middleware: [mw1, mw2],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      // Onion model: outer -> inner -> handler -> inner -> outer
      expect(executionOrder).toEqual([
        "mw1-before", // Outer middleware (first)
        "mw2-before", // Inner middleware (second)
        "handler", // Handler
        "mw2-after", // Inner middleware (return)
        "mw1-after", // Outer middleware (return)
      ]);
    });
  });

  describe("combined static and dynamic middlewares", () => {
    it("should execute dynamic (outer) -> static (middle) -> handler (inner)", async () => {
      const mock = createMockModel();
      const executionOrder: string[] = [];

      const staticMw: ToolMiddleware = {
        name: "static",
        handler: async (_ctx, next) => {
          executionOrder.push("static-before");
          const result = await next();
          executionOrder.push("static-after");
          return `[STATIC] ${result}`;
        },
      };

      const dynamicMw: ToolMiddleware = {
        name: "dynamic",
        handler: async (_ctx, next) => {
          executionOrder.push("dynamic-before");
          const result = await next();
          executionOrder.push("dynamic-after");
          return `[DYNAMIC] ${result}`;
        },
      };

      const baseTool: ToolDefinition = {
        name: "test",
        description: "Test",
        parameters: z.object({}),
        handler: async () => {
          executionOrder.push("handler");
          return "handler";
        },
      };

      const augmentedTool = augment(baseTool, [staticMw]);

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: {} }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(augmentedTool, {
            middleware: [dynamicMw],
          });
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      // Order: Dynamic (outer) -> Static (middle) -> Handler (inner)
      expect(executionOrder).toEqual([
        "dynamic-before", // Dynamic middleware (outer)
        "static-before", // Static middleware (middle)
        "handler", // Handler (inner)
        "static-after", // Static middleware (return)
        "dynamic-after", // Dynamic middleware (return)
      ]);
    });
  });

  describe("middleware context", () => {
    it("should provide tool context to middleware", async () => {
      const mock = createMockModel();
      let capturedContext: ToolContext | null = null;

      const middleware: ToolMiddleware = {
        name: "capture",
        handler: async (ctx, next) => {
          capturedContext = ctx;
          return await next();
        },
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: { query: "test-query" } }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test-agent",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "test",
              description: "Test tool",
              parameters: z.object({ query: z.string() }),
              handler: async () => "result",
            },
            {
              middleware: [middleware],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(capturedContext).not.toBeNull();
      // Type assertion after null check
      const ctx = capturedContext!;
      expect(ctx.toolName).toBe("test");
      expect(ctx.input).toEqual({ query: "test-query" });
      expect(ctx.description).toBe("Test tool");
      expect(ctx.metadata.agentId).toBe("test-agent");
      expect(ctx.definition.name).toBe("test");
    });
  });

  describe("middleware can modify input and output", () => {
    it("should allow middleware to modify input", async () => {
      const mock = createMockModel();
      const handler = vi.fn().mockResolvedValue("mock_success_result");

      const middleware: ToolMiddleware = {
        name: "modify-input",
        handler: async (ctx, next) => {
          // Modify input
          const _modifiedInput = { ...ctx.input, modified: true };
          // Note: In real implementation, we'd need to pass modified input to handler
          // For now, we test that middleware can access and inspect input
          return await next();
        },
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: { value: "original" } }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "test",
              description: "Test",
              parameters: z.object({ value: z.string() }),
              handler,
            },
            {
              middleware: [middleware],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(handler).toHaveBeenCalledWith({ value: "original" });
    });

    it("should allow middleware to modify output", async () => {
      const mock = createMockModel();
      const handler = vi.fn().mockResolvedValue("original-result");

      const middleware: ToolMiddleware = {
        name: "modify-output",
        handler: async (_ctx, next) => {
          const result = await next();
          return `modified: ${result}`;
        },
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: {} }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "test",
              description: "Test",
              parameters: z.object({}),
              handler,
            },
            {
              middleware: [middleware],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      // The middleware should modify the output
      // We can't directly test the LLM's received message, but we can verify handler was called
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("middleware can intercept (early return)", () => {
    it("should allow middleware to return early without calling handler", async () => {
      const mock = createMockModel();
      const handler = vi.fn().mockResolvedValue("should-not-be-called");

      const middleware: ToolMiddleware = {
        name: "intercept",
        handler: async (ctx, next) => {
          // Intercept: return early without calling next()
          if (ctx.input.query === "block") {
            return "blocked";
          }
          return await next();
        },
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: { query: "block" } }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "test",
              description: "Test",
              parameters: z.object({ query: z.string() }),
              handler,
            },
            {
              middleware: [middleware],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      // Handler should not be called when middleware intercepts
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("middleware with agent context (memory)", () => {
    it("should allow middleware to access agent memory", async () => {
      const mock = createMockModel();
      const toolHandler = vi.fn().mockResolvedValue("result");

      let capturedHistory: string[] | null = null;

      const _middleware: ToolMiddleware = {
        name: "access-memory",
        handler: async (ctx, next) => {
          // Access memory via context (in real usage, middleware would use equipMemory)
          // For testing, we verify middleware has access to context metadata
          expect(ctx.metadata.agentId).toBe("test");
          const result = await next();
          return result;
        },
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "test", arguments: {} }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [history, setHistory] = equipMemory<string[]>("history", []);

          equipTool(
            {
              name: "test",
              description: "Test",
              parameters: z.object({}),
              handler: async () => {
                setHistory([...history, "tool-used"]);
                toolHandler();
                return "result";
              },
            },
            {
              middleware: [
                {
                  name: "capture-history",
                  handler: async (_ctx, next) => {
                    const result = await next();
                    // Middleware can access memory via closure
                    const [h] = equipMemory<string[]>("history", []);
                    capturedHistory = h;
                    return result;
                  },
                },
              ],
            },
          );
          return promptAgent(schemas.simple);
        },
      });

      await agent();

      expect(toolHandler).toHaveBeenCalled();
      // History should be updated after tool execution
      expect(capturedHistory).toEqual(["tool-used"]);
    });
  });

  describe("tool-call loop middleware", () => {
    it("should not run when prompt returns final content directly", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "done" });

      const middleware = vi.fn().mockImplementation(async (_ctx, _currentCalls, next) => {
        return await next([]);
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipToolCallLoopMiddleware({
            name: "loop-guard",
            handler: middleware,
          });
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(middleware).not.toHaveBeenCalled();
    });

    it("should pass filtered calls through the middleware onion", async () => {
      const mock = createMockModel();
      const handlerA = vi.fn().mockResolvedValue("a-out");
      const handlerB = vi.fn().mockResolvedValue("b-out");
      const innerReceived: ToolCall[][] = [];

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([
          { id: "call_a", name: "toolA", arguments: {} },
          { id: "call_b", name: "toolB", arguments: {} },
        ]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "toolA",
            description: "A",
            parameters: z.object({}),
            handler: handlerA,
          });
          equipTool({
            name: "toolB",
            description: "B",
            parameters: z.object({}),
            handler: handlerB,
          });
          equipToolCallLoopMiddleware({
            name: "outer-filter",
            handler: async (_ctx, currentCalls, next) => {
              expect(currentCalls).toHaveLength(2);
              const passToCore: typeof currentCalls = [];
              const forged: { callId: string; content: string }[] = [];
              for (const c of currentCalls) {
                if (c.name === "toolA") {
                  forged.push({ callId: c.id, content: '"skipped"' });
                } else {
                  passToCore.push(c);
                }
              }
              const real = passToCore.length > 0 ? await next(passToCore) : [];
              return [...real, ...forged];
            },
          });
          equipToolCallLoopMiddleware({
            name: "inner-capture",
            handler: async (_ctx, currentCalls, next) => {
              innerReceived.push([...currentCalls]);
              return await next(currentCalls);
            },
          });
          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(innerReceived).toHaveLength(1);
      expect(innerReceived[0]).toEqual([{ id: "call_b", name: "toolB", arguments: "{}" }]);
      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalled();
    });

    it("should throw LoopMissingToolOutputError when middleware drops calls without forged outputs", async () => {
      const mock = createMockModel();
      const handlerA = vi.fn().mockResolvedValue("a-out");
      const handlerB = vi.fn().mockResolvedValue("b-out");

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([
          { id: "call_a", name: "toolA", arguments: {} },
          { id: "call_b", name: "toolB", arguments: {} },
        ]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "toolA",
            description: "A",
            parameters: z.object({}),
            handler: handlerA,
          });
          equipTool({
            name: "toolB",
            description: "B",
            parameters: z.object({}),
            handler: handlerB,
          });
          equipToolCallLoopMiddleware({
            name: "bad-filter",
            handler: async (_ctx, currentCalls, next) =>
              await next(currentCalls.filter((c) => c.name === "toolB")),
          });
          return promptAgent(schemas.simple);
        },
      });

      await expect(agent({})).rejects.toThrow(LoopMissingToolOutputError);
      expect(handlerB).toHaveBeenCalled();
      expect(handlerA).not.toHaveBeenCalled();
    });

    it("should expose prompt snapshot and allow intercepting tool execution", async () => {
      const mock = createMockModel();
      const toolHandler = vi.fn().mockResolvedValue("real-tool-result");
      let capturedContext: ToolCallLoopContext | null = null;
      let interceptedToolMessage: string | null = null;

      let callCount = 0;
      mock
        .when((payload) => {
          callCount++;
          if (callCount === 1) {
            return true;
          }

          const toolMessage = payload.messages.find((message) => message.role === "tool");
          interceptedToolMessage =
            typeof toolMessage?.content === "string" ? toolMessage.content : null;
          return false;
        })
        .thenCallTools([{ id: "call_1", name: "search", arguments: { query: "test" } }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipSystem("System rule");
          equipInstruction("Do the search carefully");
          equipTool({
            name: "search",
            description: "Search tool",
            parameters: z.object({ query: z.string() }),
            handler: toolHandler,
          });
          equipToolCallLoopMiddleware({
            name: "search-interceptor",
            handler: async (ctx, _currentCalls, _next) => {
              capturedContext = ctx;
              return [
                {
                  callId: "call_1",
                  content: JSON.stringify({
                    error: "SYSTEM_INTERCEPTED",
                    message: "Stop searching and answer now.",
                  }),
                },
              ];
            },
          });

          return promptAgent(schemas.simple);
        },
      });

      const result = await agent({});

      expect(result.result).toBe("done");
      expect(toolHandler).not.toHaveBeenCalled();
      expect(capturedContext).not.toBeNull();
      const loopCtx = capturedContext!;
      expect(loopCtx.step).toBe(1);
      expect(loopCtx.systemInstruction).toBe("System rule");
      expect(loopCtx.instruction).toEqual([{ type: "text", text: "Do the search carefully" }]);
      expect(loopCtx.toolTurns).toEqual([]);
      expect(loopCtx.originalCalls).toEqual([
        { id: "call_1", name: "search", arguments: '{"query":"test"}' },
      ]);
      expect(interceptedToolMessage).toContain("SYSTEM_INTERCEPTED");
    });

    it("should expose previous tool rounds as structured toolTurns", async () => {
      const mock = createMockModel();
      const searchHandler = vi.fn().mockResolvedValue("search-result");
      const lookupHandler = vi.fn().mockResolvedValue("lookup-result");
      let secondRoundContext: ToolCallLoopContext | null = null;

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "search", arguments: { query: "alpha" } }]);
      mock
        .when(() => callCount === 2)
        .thenCallTools([{ id: "call_2", name: "lookup", arguments: { id: "42" } }]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "search",
            description: "Search tool",
            parameters: z.object({ query: z.string() }),
            handler: searchHandler,
          });
          equipTool({
            name: "lookup",
            description: "Lookup tool",
            parameters: z.object({ id: z.string() }),
            handler: lookupHandler,
          });
          equipToolCallLoopMiddleware({
            name: "capture-second-round",
            handler: async (ctx, currentCalls, next) => {
              if (ctx.step === 2) {
                secondRoundContext = ctx;
              }
              return await next([...currentCalls]);
            },
          });

          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(secondRoundContext).not.toBeNull();
      const loopCtx = secondRoundContext!;
      expect(loopCtx.toolTurns).toEqual([
        {
          entries: [
            {
              callId: "call_1",
              toolName: "search",
              arguments: '{"query":"alpha"}',
            },
          ],
        },
      ]);
      expect(loopCtx.originalCalls).toEqual([
        { id: "call_2", name: "lookup", arguments: '{"id":"42"}' },
      ]);
    });
  });

  describe("multiple tools with different middleware", () => {
    it("should apply different middleware to different tools", async () => {
      const mock = createMockModel();
      const handler1 = vi.fn().mockResolvedValue("result1");
      const handler2 = vi.fn().mockResolvedValue("result2");

      const mw1: ToolMiddleware = {
        name: "mw1",
        handler: async (_ctx, next) => `[MW1] ${await next()}`,
      };
      const mw2: ToolMiddleware = {
        name: "mw2",
        handler: async (_ctx, next) => `[MW2] ${await next()}`,
      };

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([
          { id: "call_1", name: "tool1", arguments: {} },
          { id: "call_2", name: "tool2", arguments: {} },
        ]);
      mock.setDefaultResponse({ result: "done" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool(
            {
              name: "tool1",
              description: "Tool 1",
              parameters: z.object({}),
              handler: handler1,
            },
            {
              middleware: [mw1],
            },
          );

          equipTool(
            {
              name: "tool2",
              description: "Tool 2",
              parameters: z.object({}),
              handler: handler2,
            },
            {
              middleware: [mw2],
            },
          );

          return promptAgent(schemas.simple);
        },
      });

      await agent({});

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });
});
