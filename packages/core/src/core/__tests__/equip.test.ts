/**
 * Equip Functions Tests
 *
 * Tests for equipSystem, equipInstruction, equipTool, equipBudget
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import type { BudgetState } from "../domain/budget";
import { DuplicateToolNameError, ToolLoopExceededError } from "../domain/errors";
import { isInstructionMessage } from "../domain/model";
import { createAgent } from "../engine/agent";
import { getUsageStats } from "../engine/budget-system";
import { reborn } from "../engine/flow/reborn";
import { executeTools } from "../engine/tool-executor";
import { executeTurn } from "../engine/turn";
import { equipInstruction, equipSystem, equipTool } from "../facade/equip/equip";
import { equipMemo, equipMemory } from "../facade/equip/memory";
import { equipResource } from "../facade/equip/resource";
import { createAgentPolicy } from "../policy/prompt";
import { promptAgent } from "../policy/prompt-schema";

describe("equipSystem & equipInstruction", () => {
  it("equipSystem adds system message", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        equipSystem("You are a helpful assistant.");
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    const messages = mock.calls.last()?.messages;
    const system = messages?.find((m) => m.role === "system");
    expect(system?.content).toBe("You are a helpful assistant.");
  });

  it("multiple equipSystem stay separate system messages (adapters flatten at the wire)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        equipSystem("Be helpful.");
        equipSystem("Be concise.");
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    const systems = mock.calls.last()?.messages?.filter((m) => m.role === "system");
    expect(systems?.map((m) => m.content)).toEqual(["Be helpful.", "Be concise."]);
  });

  it("equipInstruction adds user message", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        equipInstruction("Do task A");
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    const user = mock.calls.last()?.messages?.find((m) => m.role === "user");
    expect(user?.content).toEqual([{ type: "text", text: "Do task A" }]);
  });

  it("multiple equipInstruction stay separate instruction-marked user messages", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        equipInstruction("Task A");
        equipInstruction("Task B");
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    const users = mock.calls.last()?.messages?.filter((m) => m.role === "user");
    expect(users?.map((m) => m.content)).toEqual([
      [{ type: "text", text: "Task A" }],
      [{ type: "text", text: "Task B" }],
    ]);
    expect(users?.every((m) => isInstructionMessage(m))).toBe(true);
  });

  it("equipInstruction supports multimodal content (ContentPart[])", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        equipInstruction([
          { type: "text", text: "请看这张图：" },
          { type: "image", image: { url: "https://example.com/chart.png" } },
          { type: "text", text: "图表中的趋势是上升还是下降？" },
        ]);
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    const user = mock.calls.last()?.messages?.find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    if (Array.isArray(user?.content)) {
      expect(user.content).toHaveLength(3);
      expect(user.content[0]).toEqual({ type: "text", text: "请看这张图：" });
      expect(user.content[1]).toEqual({
        type: "image",
        image: { url: "https://example.com/chart.png" },
      });
      expect(user.content[2]).toEqual({ type: "text", text: "图表中的趋势是上升还是下降？" });
    }
  });

  it("equipInstruction supports mixing string and ContentPart[]", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        equipInstruction("Task A");
        equipInstruction([
          { type: "text", text: "请看这张图：" },
          { type: "image", image: { url: "https://example.com/chart.png" } },
        ]);
        return promptAgent(schemas.simple);
      },
    });

    await agent({});

    // Each equipInstruction stays its own message (preserves per-block metadata for adapters)
    const users = mock.calls.last()?.messages?.filter((m) => m.role === "user");
    expect(users?.map((m) => m.content)).toEqual([
      [{ type: "text", text: "Task A" }],
      [
        { type: "text", text: "请看这张图：" },
        { type: "image", image: { url: "https://example.com/chart.png" } },
      ],
    ]);
  });
});

describe("equipTool", () => {
  describe("tool registration", () => {
    it("registers and executes tool", async () => {
      const mock = createMockModel();
      const searchHandler = vi.fn().mockResolvedValue({ results: ["a", "b"] });

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "search", arguments: { query: "test" } }]);
      mock.setDefaultResponse({ answer: "found" });

      const agent = createAgent({
        id: "test",
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

      await agent({});

      expect(searchHandler).toHaveBeenCalledWith({ query: "test" });
    });

    it("executes multiple tools in parallel", async () => {
      const mock = createMockModel();
      const order: string[] = [];

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([
          { id: "call_1", name: "slow", arguments: {} },
          { id: "call_2", name: "fast", arguments: {} },
        ]);
      mock.setDefaultResponse({ done: true });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "slow",
            description: "Slow",
            parameters: z.object({}),
            handler: async () => {
              order.push("slow_start");
              await new Promise((r) => setTimeout(r, 50));
              order.push("slow_end");
              return "slow";
            },
          });
          equipTool({
            name: "fast",
            description: "Fast",
            parameters: z.object({}),
            handler: async () => {
              order.push("fast_start");
              await new Promise((r) => setTimeout(r, 10));
              order.push("fast_end");
              return "fast";
            },
          });
          return promptAgent(schemas.done);
        },
      });

      await agent({});

      // Fast should finish before slow
      expect(order).toEqual(["slow_start", "fast_start", "fast_end", "slow_end"]);
    });

    it("throws DuplicateToolNameError when the same name is equipped twice", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => {
          equipTool({
            name: "search",
            description: "First",
            parameters: z.object({}),
            handler: async () => "first",
          });
          equipTool({
            name: "search",
            description: "Second",
            parameters: z.object({}),
            handler: async () => "second",
          });
          return promptAgent(schemas.simple);
        },
      });

      await expect(agent({})).rejects.toThrow(DuplicateToolNameError);
    });

    it("allows re-equipping the same name after reborn (draft is cleared)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      let runCount = 0;
      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          runCount++;
          equipTool({
            name: "search",
            description: "Search",
            parameters: z.object({}),
            handler: async () => "ok",
          });
          await promptAgent(schemas.simple);
          if (runCount < 2) return reborn();
          return { runCount };
        },
      });

      const result = await agent({});
      expect(result.runCount).toBe(2);
    });
  });

  describe("duplicate name validation at engine boundary", () => {
    // fork({ tools }) and hand-built PromptRuntime bypass equipTool's registration
    // check; executeTurn / executeTools must still reject duplicate names.
    it("executeTurn rejects duplicate names introduced via fork({ tools })", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const policy = createAgentPolicy({
        policyId: "dup-fork-turn",
        handler: async (promptCtx) => {
          const forked = promptCtx.fork({
            tools: (base) => [
              ...base,
              {
                name: "search",
                description: "Shadowing duplicate",
                parameters: z.object({}),
                handler: async () => "dup",
              },
            ],
          });
          return await executeTurn(forked.messages, { runtime: forked });
        },
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => {
          equipTool({
            name: "search",
            description: "Original",
            parameters: z.object({}),
            handler: async () => "ok",
          });
          await policy();
          return { result: "unreachable" };
        },
      });

      await expect(agent({})).rejects.toThrow(DuplicateToolNameError);
    });

    it("executeTools rejects duplicate names in a runtime tool set", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "ok" });

      const policy = createAgentPolicy({
        policyId: "dup-fork-tools",
        handler: async (promptCtx) => {
          const forked = promptCtx.fork({ tools: (base) => [...base, ...base] });
          return await executeTools([{ id: "call_1", name: "search", arguments: "{}" }], {
            runtime: forked,
          });
        },
      });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => {
          equipTool({
            name: "search",
            description: "Original",
            parameters: z.object({}),
            handler: async () => "ok",
          });
          await policy();
          return { result: "unreachable" };
        },
      });

      await expect(agent({})).rejects.toThrow(DuplicateToolNameError);
    });
  });

  describe("error handling", () => {
    it("tool error returns message to LLM", async () => {
      const mock = createMockModel();
      let toolResultContent: string | null = null;

      let callCount = 0;
      mock
        .when((p) => {
          if (++callCount > 1) {
            const toolMsg = p.messages.find((m) => m.role === "tool");
            if (toolMsg) toolResultContent = toolMsg.content as string;
          }
          return callCount === 1;
        })
        .thenCallTools([{ id: "call_1", name: "broken", arguments: {} }]);
      mock.setDefaultResponse({ recovered: true });

      const agent = createAgent({
        id: "test",
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
      expect(toolResultContent).toContain("error");
    });

    it("unknown tool returns error message", async () => {
      const mock = createMockModel();

      let callCount = 0;
      mock
        .when(() => ++callCount === 1)
        .thenCallTools([{ id: "call_1", name: "unknown_tool", arguments: {} }]);
      mock.setDefaultResponse({ fallback: true });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipTool({
            name: "known_tool",
            description: "Known",
            parameters: z.object({}),
            handler: async () => "ok",
          });
          return promptAgent(z.object({ fallback: z.boolean() }));
        },
      });

      const result = await agent({});
      expect(result.fallback).toBe(true);
    });
  });

  describe("tool loop limit", () => {
    it("throws ToolLoopExceededError when limit reached", async () => {
      const mock = createMockModel();

      mock.when(() => true).thenCallTools([{ id: "call_loop", name: "infinite", arguments: {} }]);

      const handler = vi.fn().mockResolvedValue("keep going");

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => {
          equipTool({
            name: "infinite",
            description: "Infinite",
            parameters: z.object({}),
            handler,
          });
          return promptAgent(schemas.done);
        },
      });

      await expect(agent({})).rejects.toThrow(ToolLoopExceededError);
      expect(handler).toHaveBeenCalledTimes(9); // last LLM turn skips tool execution (budget exhausted)
    });
  });
});

describe("equipBudget", () => {
  it("tracks token usage", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenReturn({ result: "ok" })
      .withUsage({ promptTokens: 100, completionTokens: 50 });

    let stats!: BudgetState;

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await promptAgent(schemas.simple);
        stats = getUsageStats();
        return { done: true };
      },
    });

    await agent({});

    expect(stats.aggregate.promptTokens).toBe(100);
    expect(stats.aggregate.completionTokens).toBe(50);
    expect(stats.aggregate.totalTokens).toBe(150);
  });

  it("accumulates across reborn", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenReturn({ continue: true })
      .withUsage({ promptTokens: 100, completionTokens: 50 });

    let runCount = 0;
    let finalStats!: BudgetState;

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        runCount++;
        await promptAgent(z.object({ continue: z.boolean() }));

        if (runCount < 3) return reborn();

        finalStats = getUsageStats();
        return { done: true };
      },
    });

    await agent({});

    expect(finalStats.aggregate.totalTokens).toBe(450); // 150 * 3
    expect(finalStats.aggregate.callCount).toBe(3);
  });
});

describe("equipMemory", () => {
  it("stores and retrieves plain data", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const [count, setCount] = equipMemory("count", 0);
        setCount(count + 1);
        const [updated] = equipMemory("count", 0);
        return { count: updated };
      },
    });

    const result = await agent({});
    expect(result.count).toBe(1);
  });

  it("returns snapshot (deep copy) to prevent direct mutation", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const [list, setList] = equipMemory<string[]>("list", ["a"]);

        // Try to mutate the returned value directly
        list.push("b");

        // Get value again - should still be ['a'] because we got a snapshot
        const [list2] = equipMemory<string[]>("list", []);

        // Proper update using setter
        setList((prev) => [...prev, "c"]);
        const [list3] = equipMemory<string[]>("list", []);

        return { list2, list3 };
      },
    });

    const result = await agent({});
    // Direct mutation should not affect stored value
    expect(result.list2).toEqual(["a"]);
    // Proper update should work
    expect(result.list3).toEqual(["a", "c"]);
  });

  it("value modification does not affect stored memory", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const [obj] = equipMemory("obj", { count: 0, name: "test" });

        // Try to modify value directly
        obj.count = 100;
        obj.name = "modified";

        // Get value again - should still be original because value is a snapshot
        const [obj2] = equipMemory("obj", { count: 0, name: "test" });

        return { original: obj, retrieved: obj2 };
      },
    });

    const result = await agent({});
    // Direct modification should not affect stored value
    expect(result.retrieved).toEqual({ count: 0, name: "test" });
  });

  it("rejects function values", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          // @ts-expect-error intentional: runtime rejects non-JSON values
          equipMemory("fn", () => {});
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects class instances (Date)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          // @ts-expect-error intentional: runtime rejects non-JSON values
          equipMemory("date", new Date());
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects Map instances", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          // @ts-expect-error intentional: runtime rejects non-JSON values
          equipMemory("map", new Map());
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects Set instances", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          // @ts-expect-error intentional: runtime rejects non-JSON values
          equipMemory("set", new Set());
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects circular references", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const circular: any = { a: 1 };
        circular.self = circular;

        expect(() => {
          equipMemory("circular", circular);
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects Symbol values", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          // @ts-expect-error intentional: runtime rejects non-JSON values
          equipMemory("sym", Symbol("test"));
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects values with undefined properties", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          // @ts-expect-error intentional: runtime rejects non-JSON values
          equipMemory("obj", { a: 1, b: undefined });
        }).toThrow(/JSON serializable/);
        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("accepts valid JSON-serializable values", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        // All these should work
        const [str] = equipMemory("str", "hello");
        const [num] = equipMemory("num", 42);
        const [bool] = equipMemory("bool", true);
        const [nullVal] = equipMemory("null", null);
        const [arr] = equipMemory("arr", [1, 2, 3]);
        const [obj] = equipMemory("obj", { a: 1, b: "test" });
        const [nested] = equipMemory("nested", { a: { b: { c: 123 } } });
        // Object.create(null) should work (no prototype, but still plain object)
        const [nullProto] = equipMemory(
          "nullProto",
          Object.create(null, { key: { value: "value", enumerable: true } }),
        );

        return { str, num, bool, nullVal, arr, obj, nested, nullProto };
      },
    });

    const result = await agent({});
    expect(result.str).toBe("hello");
    expect(result.num).toBe(42);
    expect(result.bool).toBe(true);
    expect(result.nullVal).toBe(null);
    expect(result.arr).toEqual([1, 2, 3]);
    expect(result.obj).toEqual({ a: 1, b: "test" });
    expect(result.nested).toEqual({ a: { b: { c: 123 } } });
    expect(result.nullProto).toEqual({ key: "value" });
  });

  it("validates on setValue as well", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const [, setValue] = equipMemory("test", {});

        expect(() => {
          setValue(new Date());
        }).toThrow(/JSON serializable/);

        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("validates functional update return value", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const [, setValue] = equipMemory("test", {});

        expect(() => {
          setValue(() => new Map());
        }).toThrow(/JSON serializable/);

        return { result: "ok" };
      },
    });

    await agent({});
  });

  it("rejects custom class instances", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    class User {
      constructor(public name: string) {}
    }

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        expect(() => {
          equipMemory("user", new User("test"));
        }).toThrow(/JSON serializable/);

        return { result: "ok" };
      },
    });

    await agent({});
  });
});

describe("equipMemo", () => {
  it("caches result when dependencies unchanged", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const factory = vi.fn().mockResolvedValue({ computed: "value" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const result1 = await equipMemo("test-key", factory, [1, 2]);
        const result2 = await equipMemo("test-key", factory, [1, 2]);
        return { result1, result2 };
      },
    });

    const result = await agent({});

    // Factory should only be called once
    expect(factory).toHaveBeenCalledTimes(1);
    // Both results should be the same cached value (deep equal, but different references due to cloning)
    expect(result.result1).toEqual({ computed: "value" });
    expect(result.result2).toEqual({ computed: "value" });
    expect(result.result1).toEqual(result.result2); // Deep equal, but different references
  });

  it("recomputes when dependencies change", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const factory = vi
      .fn()
      .mockResolvedValueOnce({ computed: "value1" })
      .mockResolvedValueOnce({ computed: "value2" });

    let callCount = 0;
    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        callCount++;
        const deps = callCount === 1 ? [1, 2] : [1, 3]; // Different deps on second call
        return await equipMemo("test-key", factory, deps);
      },
    });

    const result1 = await agent({});
    const result2 = await agent({});

    // Factory should be called twice (once per different deps)
    expect(factory).toHaveBeenCalledTimes(2);
    expect(result1).toEqual({ computed: "value1" });
    expect(result2).toEqual({ computed: "value2" });
  });

  it("preserves cache across reborn", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ continue: true });

    const factory = vi.fn().mockResolvedValue({ computed: "value" });

    let runCount = 0;
    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        runCount++;
        const result = await equipMemo("test-key", factory, [1, 2]);

        if (runCount < 2) {
          return reborn();
        }

        return { result, runCount };
      },
    });

    const result = await agent({});

    // Factory should only be called once (cached on reborn)
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.result).toEqual({ computed: "value" });
    expect(result.runCount).toBe(2);
  });

  it("handles shallow compare dependencies", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const create = vi.fn().mockResolvedValueOnce({ id: "a" }).mockResolvedValueOnce({ id: "b" });
    const destroy = vi.fn().mockResolvedValue(undefined);

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const stableRef = { id: 1 };
        const stableDeps = [stableRef];
        const res1 = await equipResource("r", { create, destroy, deps: stableDeps });
        const res2 = await equipResource("r", { create, destroy, deps: stableDeps });
        const res3 = await equipResource("r", { create, destroy, deps: [{ id: 1 }] });
        return { res1, res2, res3 };
      },
    });

    const result = await agent({});

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.res1).toBe(result.res2);
    expect(result.res3).toEqual({ id: "b" });
  });

  it("handles deep object dependencies", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const factory = vi
      .fn()
      .mockResolvedValueOnce({ computed: "value1" })
      .mockResolvedValueOnce({ computed: "value2" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        const result1 = await equipMemo("test-key", factory, [{ id: 1 }]);
        const result2 = await equipMemo("test-key", factory, [{ id: 1 }]);
        const result3 = await equipMemo("test-key", factory, [{ id: 2 }]);
        return { result1, result2, result3 };
      },
    });

    const result = await agent({});

    expect(factory).toHaveBeenCalledTimes(2);
    expect(result.result1).toEqual({ computed: "value1" });
    expect(result.result2).toEqual({ computed: "value1" });
    expect(result.result3).toEqual({ computed: "value2" });
  });

  it("throws TypeError when deps are not JSON-serializable (runtime)", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const factory = vi.fn().mockResolvedValue({ ok: true });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await equipMemo("bad-deps-key", factory, [() => {}] as unknown as []);
        return "should-not-run";
      },
    });

    await expect(agent({})).rejects.toThrow(/equipMemo\("bad-deps-key"\) deps/);
    expect(factory).not.toHaveBeenCalled();
  });
});
