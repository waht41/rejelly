/**
 * Agent Middleware Tests
 *
 * Tests for agent middleware chain (augment)
 */

import { describe, expect, it, vi } from "vitest";
import { createMockModel, schemas } from "../../testing/helpers";
import type {
  AgentFunction,
  AgentMiddleware,
  AgentMiddlewareContext,
  InternalAgentFunction,
} from "../context/agent";
import { createAgent } from "../engine/agent";
import { augmentAgent } from "../facade/augment";
import { equipMemory } from "../facade/equip/memory";
import { promptAgent } from "../policy/prompt-schema";
import { kConfig } from "../shared/symbols";

export function getInternalConfig<P = unknown, R = unknown>(agent: AgentFunction<P, R>) {
  return (agent as InternalAgentFunction<P, R>)[kConfig];
}

describe("Agent Middleware Chain", () => {
  describe("augment - static middleware", () => {
    it("should augment agent with static middleware", () => {
      const baseAgent = createAgent({
        id: "test-agent",
        handler: async () => "result",
      });

      const logMiddleware: AgentMiddleware<unknown, string> = {
        name: "log",
        handler: async (_ctx, next) => {
          return `[LOG] ${await next()}`;
        },
      };

      const augmented = augmentAgent(baseAgent, [logMiddleware]);

      expect(augmented.id).toBe("test-agent");
      // Check that middleware is in config
      expect(getInternalConfig(augmented).middlewares).toHaveLength(1);
      expect(getInternalConfig(augmented).middlewares?.[0]).toBe(logMiddleware);
    });

    it("should chain multiple static middlewares", () => {
      const baseAgent = createAgent({
        id: "test-agent",
        handler: async () => "result",
      });

      const mw1: AgentMiddleware<unknown, string> = {
        name: "mw1",
        handler: async (_ctx, next) => `[MW1] ${await next()}`,
      };
      const mw2: AgentMiddleware<unknown, string> = {
        name: "mw2",
        handler: async (_ctx, next) => `[MW2] ${await next()}`,
      };

      const augmented = augmentAgent(baseAgent, [mw1, mw2]);

      expect(getInternalConfig(augmented).middlewares).toHaveLength(2);
      expect(getInternalConfig(augmented).middlewares?.[0]).toBe(mw1);
      expect(getInternalConfig(augmented).middlewares?.[1]).toBe(mw2);
    });

    it("should preserve existing middlewares when augmenting", () => {
      const baseAgent = createAgent({
        id: "test-agent",
        handler: async () => "result",
        middlewares: [
          {
            name: "existing",
            handler: async (_ctx, next) => `[EXISTING] ${await next()}`,
          },
        ],
      });

      const newMw: AgentMiddleware<unknown, string> = {
        name: "new",
        handler: async (_ctx, next) => `[NEW] ${await next()}`,
      };
      const augmented = augmentAgent(baseAgent, [newMw]);

      expect(getInternalConfig(augmented).middlewares).toHaveLength(2);
      expect(getInternalConfig(augmented).middlewares?.[0]).toBe(
        getInternalConfig(baseAgent).middlewares![0],
      );
      expect(getInternalConfig(augmented).middlewares?.[1]).toBe(newMw);
    });
  });

  describe("middleware execution order", () => {
    it("should execute middlewares in onion model order", async () => {
      const mock = createMockModel();
      const executionOrder: string[] = [];

      const mw1: AgentMiddleware<unknown, { result: string }> = {
        name: "mw1",
        handler: async (_ctx, next) => {
          executionOrder.push("mw1-before");
          const result = await next();
          executionOrder.push("mw1-after");
          return { result: `[MW1] ${result.result}` };
        },
      };

      const mw2: AgentMiddleware<unknown, { result: string }> = {
        name: "mw2",
        handler: async (_ctx, next) => {
          executionOrder.push("mw2-before");
          const result = await next();
          executionOrder.push("mw2-after");
          return { result: `[MW2] ${result.result}` };
        },
      };

      mock.setDefaultResponse({ result: "done" });

      const baseAgent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          executionOrder.push("handler");
          return await promptAgent(schemas.simple);
        },
      });

      const augmentedAgent = augmentAgent(baseAgent, [mw1, mw2]);

      await augmentedAgent({});

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

  describe("middleware context", () => {
    it("should provide agent context to middleware", async () => {
      const mock = createMockModel();
      let capturedContext: AgentMiddlewareContext | null = null;

      const middleware: AgentMiddleware<{ topic: string }, { result: string }> = {
        name: "capture",
        handler: async (ctx, next) => {
          capturedContext = ctx;
          return await next();
        },
      };

      mock.setDefaultResponse({ result: "done" });

      const baseAgent = createAgent({
        id: "test-agent",
        model: mock.adapter,
        handler: async (_props?: { topic: string }) => {
          return await promptAgent(schemas.simple);
        },
      });

      const augmentedAgent = augmentAgent(baseAgent, [middleware]);

      await augmentedAgent({ topic: "test-topic" });

      expect(capturedContext).not.toBeNull();
      const ctx = capturedContext!;
      expect(ctx.agentId).toBe("test-agent");
      expect(ctx.props).toEqual({ topic: "test-topic" });
    });
  });

  describe("middleware can modify props and output", () => {
    it("should allow middleware to modify props", async () => {
      const mock = createMockModel();
      const handler: (props: { value: string }) => Promise<string> = vi
        .fn()
        .mockImplementation(async (props: { value: string }): Promise<string> => {
          return `result: ${props.value}`;
        });

      const middleware: AgentMiddleware<{ value: string }, string> = {
        name: "modify-props",
        handler: async (ctx, next) => {
          // Modify props
          ctx.props = { ...ctx.props, value: "modified" };
          return await next();
        },
      };

      mock.setDefaultResponse({ result: "done" });

      const baseAgent = createAgent({
        id: "test",
        model: mock.adapter,
        handler,
      });

      const augmentedAgent = augmentAgent(baseAgent, [middleware]);

      const _result = await augmentedAgent({ value: "original" });

      // Handler should receive modified props
      expect(handler).toHaveBeenCalledWith({ value: "modified" });
    });

    it("should allow middleware to modify output", async () => {
      const mock = createMockModel();
      const handler: () => Promise<string> = vi
        .fn()
        .mockImplementation(async () => "original-result");

      const middleware: AgentMiddleware<unknown, string> = {
        name: "modify-output",
        handler: async (_ctx, next) => {
          const result = await next();
          return `modified: ${result}`;
        },
      };

      mock.setDefaultResponse({ result: "done" });

      const baseAgent = createAgent({
        id: "test",
        model: mock.adapter,
        handler,
      });

      const augmentedAgent = augmentAgent(baseAgent, [middleware]);

      const result = await augmentedAgent({});

      // The middleware should modify the output
      expect(result).toBe("modified: original-result"); // promptAgent result
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("middleware can intercept (early return)", () => {
    it("should allow middleware to return early without calling handler", async () => {
      const mock = createMockModel();
      const handler: (props: { action: string }) => Promise<string> = vi
        .fn()
        .mockImplementation(async (_props: { action: string }) => "should-not-be-called");

      const middleware: AgentMiddleware<{ action: string }, string> = {
        name: "intercept",
        handler: async (ctx, next) => {
          // Intercept: return early without calling next()
          if (ctx.props.action === "block") {
            return "blocked";
          }
          return await next();
        },
      };

      mock.setDefaultResponse({ result: "done" });

      const baseAgent = createAgent({
        id: "test",
        model: mock.adapter,
        handler,
      });

      const augmentedAgent = augmentAgent(baseAgent, [middleware]);

      const result = await augmentedAgent({ action: "block" });

      // Handler should not be called when middleware intercepts
      expect(handler).not.toHaveBeenCalled();
      // Result should be the intercepted value
      expect(result).toBe("blocked");
    });
  });

  describe("middleware with agent context (memory)", () => {
    it("should allow middleware to access agent memory after execute", async () => {
      const mock = createMockModel();
      const handler: () => Promise<string> = vi.fn().mockResolvedValue("result");

      let capturedHistory: string[] | null = null;

      const middleware: AgentMiddleware<unknown, { result: string }> = {
        name: "access-memory",
        handler: async (_ctx, next) => {
          const result = await next();
          // Access memory via context
          const [history] = equipMemory<string[]>("history", []);
          capturedHistory = history;
          return result;
        },
      };

      mock.setDefaultResponse({ result: "done" });

      const baseAgent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [history, setHistory] = equipMemory<string[]>("history", []);
          setHistory([...history, "agent-called"]);
          handler();
          return await promptAgent(schemas.simple);
        },
      });

      const augmentedAgent = augmentAgent(baseAgent, [middleware]);

      await augmentedAgent({});

      expect(handler).toHaveBeenCalled();
      // History should be accessible in middleware
      expect(capturedHistory).toEqual(["agent-called"]);
    });
  });

  describe("multiple agents with different middleware", () => {
    it("should apply different middleware to different agents", async () => {
      const mock = createMockModel();
      const handler1: () => Promise<string> = vi.fn().mockImplementation(async () => "result1");
      const handler2: () => Promise<string> = vi.fn().mockImplementation(async () => "result2");

      const mw1: AgentMiddleware<unknown, string> = {
        name: "mw1",
        handler: async (_ctx, next) => `[MW1] ${await next()}`,
      };
      const mw2: AgentMiddleware<unknown, string> = {
        name: "mw2",
        handler: async (_ctx, next) => `[MW2] ${await next()}`,
      };

      mock.setDefaultResponse({ result: "done" });

      const agent1 = createAgent({
        id: "agent1",
        model: mock.adapter,
        handler: handler1,
      });

      const agent2 = createAgent({
        id: "agent2",
        model: mock.adapter,
        handler: handler2,
      });

      const augmentedAgent1 = augmentAgent(agent1, [mw1]);
      const augmentedAgent2 = augmentAgent(agent2, [mw2]);

      await augmentedAgent1({});
      await augmentedAgent2({});

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe("middleware config", () => {
    it("should support config field in middleware", () => {
      const baseAgent = createAgent({
        id: "test-agent",
        handler: async () => "result",
      });

      const middleware: AgentMiddleware<unknown, string> = {
        name: "config-test",
        handler: async (_ctx, next) => await next(),
        config: {
          level: "info",
          enabled: true,
        },
      };

      const augmented = augmentAgent(baseAgent, [middleware]);

      expect(getInternalConfig(augmented).middlewares?.[0].config).toEqual({
        level: "info",
        enabled: true,
      });
    });
  });
});
