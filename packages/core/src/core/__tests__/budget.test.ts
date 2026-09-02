/**
 * Budget tests
 *
 * - budgetGuard throws when limits exceeded (self and child-induced)
 * - onUpdate runs on every cost update (LLM + tool), budget:update events emitted
 * - getUsageStats().aggregate matches onUpdate aggregate
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockModel, schemas } from "../../testing/helpers";
import { BudgetExceededError, InvalidCostValueError } from "../domain/errors";
import { type BudgetUpdateEvent, EVENTS, type TraceEvent } from "../domain/events";
import type { TokenUsage } from "../domain/model";
import { createAgent } from "../engine/agent";
import { getUsageStats, recordToolUsage } from "../engine/budget-system";
import { reborn } from "../engine/flow/reborn";
import { budgetGuard, equipBudget } from "../facade/equip/budget";
import { equipMemory } from "../facade/equip/memory";
import { type EventBus, getGlobalEventBus, resetEventBus } from "../observability/event-bus";
import { promptAgent } from "../policy/prompt-schema";

interface CollectedEvents {
  all: TraceEvent[];
  byType: Map<string, TraceEvent[]>;
}

function createEventCollector(eventBus: EventBus): CollectedEvents {
  const collected: CollectedEvents = {
    all: [],
    byType: new Map(),
  };
  eventBus.subscribe("*", (event) => {
    collected.all.push(event);
    const typeEvents = collected.byType.get(event.type) ?? [];
    typeEvents.push(event);
    collected.byType.set(event.type, typeEvents);
  });
  return collected;
}

describe("Budget", () => {
  let eventBus: EventBus;
  let events: CollectedEvents;

  beforeEach(() => {
    resetEventBus();
    eventBus = getGlobalEventBus();
    events = createEventCollector(eventBus);
  });

  afterEach(() => {
    resetEventBus();
  });

  describe("budgetGuard throws when limit exceeded", () => {
    it("throws when self usage exceeds cost limit", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 1000, completionTokens: 500 });
      // Default mock cost: (1500 * 0.001) / 1000 USD → 1500 micro_usd
      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget(budgetGuard({ maxCosts: { micro_usd: 100 } }));
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(BudgetExceededError);
      await expect(agent({})).rejects.toThrow(/micro_usd/);
    });

    it("throws when self usage exceeds token limit", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 100, completionTokens: 50 });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget(budgetGuard({ maxTotalTokens: 100 }));
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(BudgetExceededError);
      await expect(agent({})).rejects.toThrow(/limit 100/);
    });

    it("throws when child usage causes parent aggregate to exceed limit", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 100, completionTokens: 50 });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipBudget(budgetGuard({ maxTotalTokens: 200 }));
          await promptAgent(schemas.simple);
          await ChildAgent({});
          return { done: true };
        },
      });

      await expect(ParentAgent({})).rejects.toThrow(BudgetExceededError);
      await expect(ParentAgent({})).rejects.toThrow(/limit 200/);
    });
  });

  describe("onUpdate and budget:update events", () => {
    it("calls onUpdate for LLM usage and for tool usage, and emits budget:update for each", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      const onUpdateCalls: {
        delta: { costs: { micro_usd?: number }; totalTokens: number };
        aggregate: { costs: { micro_usd?: number }; totalTokens: number };
      }[] = [];

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget({
            onUpdate: (arg) => {
              onUpdateCalls.push({
                delta: { costs: { ...arg.delta.costs }, totalTokens: arg.delta.totalTokens },
                aggregate: {
                  costs: { ...arg.aggregate.costs },
                  totalTokens: arg.aggregate.totalTokens,
                },
              });
            },
          });
          await promptAgent(schemas.simple);
          recordToolUsage({
            name: "test_tool",
            unit: "call",
            quantity: 1,
            costs: { micro_usd: 100_000 },
            details: {},
          });
          return { done: true };
        },
      });

      await agent({});

      expect(onUpdateCalls.length).toBe(2);
      expect(onUpdateCalls[0].delta.totalTokens).toBe(15);
      expect(onUpdateCalls[0].aggregate.totalTokens).toBe(15);
      expect(onUpdateCalls[1].delta.costs.micro_usd).toBe(100_000);
      expect(onUpdateCalls[1].aggregate.costs.micro_usd).toBeGreaterThanOrEqual(100_000);

      const budgetUpdates = events.byType.get(EVENTS.BUDGET_UPDATE) ?? [];
      expect(budgetUpdates.length).toBe(2);
      expect((budgetUpdates[0] as { delta: { totalTokens: number } }).delta.totalTokens).toBe(15);
      expect((budgetUpdates[1] as BudgetUpdateEvent).delta.costs.micro_usd).toBe(100_000);
    });
  });

  describe("immutability (safe clone)", () => {
    it("safeguards internal budget state from being mutated by onUpdate callbacks", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget({
            onUpdate: (arg) => {
              arg.aggregate.costs.micro_usd = 999_999_999;
              arg.delta.totalTokens = -100;
            },
          });
          await promptAgent(schemas.simple);

          const stats = getUsageStats();
          expect(stats.aggregate.costs.micro_usd).not.toBe(999_999_999);
          expect(stats.aggregate.totalTokens).toBe(15);
          return { done: true };
        },
      });

      await agent({});
    });
  });

  describe("budget:update event metadata", () => {
    it("emits budget:update with identifiers reflecting source (model vs tool)", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget({ onUpdate: () => {} });
          await promptAgent(schemas.simple);
          recordToolUsage({
            name: "dall-e",
            unit: "image",
            quantity: 1,
            costs: { micro_usd: 40_000 },
            details: {},
          });
          return { done: true };
        },
      });

      await agent({});

      const budgetUpdates = events.byType.get(EVENTS.BUDGET_UPDATE) ?? [];
      expect(budgetUpdates.length).toBe(2);
      const first = budgetUpdates[0] as { identifiers: string[] };
      const second = budgetUpdates[1] as { identifiers: string[] };
      expect(first.identifiers[0]).toMatch(/^model:/);
      expect(second.identifiers[0]).toMatch(/^tool:/);
      expect(second.identifiers[0]).toContain("dall-e");
    });

    it("sanitizes recordToolUsage details containing undefined", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      let stats: ReturnType<typeof getUsageStats> | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget({ onUpdate: () => {} });
          await promptAgent(schemas.simple);
          recordToolUsage({
            name: "test_tool",
            unit: "call",
            quantity: 1,
            costs: { micro_usd: 10_000 },
            // Intentionally pass details with undefined to assert sanitization (not valid JsonValue)
            details: {
              a: 1,
              b: undefined,
              nested: { x: "ok", y: undefined },
            } as any,
          });
          stats = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      expect(stats).not.toBeNull();
      const toolItem = stats!.own.items.find(
        (item) => item.type === "tool" && item.name === "test_tool",
      );
      expect(toolItem).toBeDefined();
      expect(toolItem!.type).toBe("tool");
      expect((toolItem as { details?: Record<string, unknown> }).details).toEqual({
        a: 1,
        nested: { x: "ok" },
      });
    });

    it("throws InvalidCostValueError when costs contain a non-integer number", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 1, completionTokens: 1 });
      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          recordToolUsage({
            name: "t",
            unit: "call",
            quantity: 1,
            costs: { micro_usd: 0.5 },
            details: {},
          });
          return { done: true };
        },
      });
      await expect(agent({})).rejects.toThrow(InvalidCostValueError);
    });

    it("aggregates model token usage attributed to a tool", async () => {
      const mock = createMockModel();
      let stats: ReturnType<typeof getUsageStats> | null = null;
      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          recordToolUsage({
            name: "web_search",
            unit: "request",
            quantity: 1,
            costs: { micro_usd: 12_000 },
            modelUsages: [
              {
                provider: "openrouter",
                model: "openai/search-model",
                usage: {
                  promptTokens: 100,
                  completionTokens: 20,
                  totalTokens: 120,
                  details: { cacheReadTokens: 40 },
                },
              },
              {
                provider: "openrouter",
                model: "rerank-model",
                usage: {
                  promptTokens: 10,
                  completionTokens: 5,
                  totalTokens: 15,
                  details: { reasoningTokens: 2 },
                },
              },
            ],
          });
          recordToolUsage({
            name: "web_search",
            unit: "request",
            quantity: 1,
            costs: { micro_usd: 8_000 },
            modelUsages: [
              {
                provider: "openrouter",
                model: "openai/search-model",
                usage: {
                  promptTokens: 50,
                  completionTokens: 10,
                  totalTokens: 60,
                  details: { cacheReadTokens: 20 },
                },
              },
            ],
          });
          stats = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      expect(stats).not.toBeNull();
      expect(stats!.aggregate).toMatchObject({
        costs: { micro_usd: 20_000 },
        promptTokens: 160,
        completionTokens: 35,
        totalTokens: 195,
        callCount: 2,
        details: { cacheReadTokens: 60, reasoningTokens: 2 },
      });
      const toolItem = stats!.aggregate.items.find(
        (item) => item.type === "tool" && item.name === "web_search",
      );
      expect(toolItem).toMatchObject({
        type: "tool",
        quantity: 2,
        costs: { micro_usd: 20_000 },
        modelUsages: [
          {
            provider: "openrouter",
            model: "openai/search-model",
            tokens: {
              prompt: 150,
              completion: 30,
              total: 180,
              details: { cacheReadTokens: 60 },
            },
          },
          {
            provider: "openrouter",
            model: "rerank-model",
            tokens: {
              prompt: 10,
              completion: 5,
              total: 15,
              details: { reasoningTokens: 2 },
            },
          },
        ],
      });
      const budgetUpdates = events.byType.get(EVENTS.BUDGET_UPDATE) ?? [];
      expect((budgetUpdates[0] as BudgetUpdateEvent).delta.totalTokens).toBe(135);
      expect((budgetUpdates[0] as BudgetUpdateEvent).delta.items).toHaveLength(1);
    });

    it("applies token budget guards to model usage inside tools", async () => {
      const mock = createMockModel();
      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget(budgetGuard({ maxTotalTokens: 10 }));
          recordToolUsage({
            name: "web_search",
            unit: "request",
            quantity: 1,
            costs: {},
            modelUsages: [
              {
                provider: "openrouter",
                model: "search-model",
                usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
              },
            ],
          });
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(BudgetExceededError);
    });
  });

  describe("agent:end and final budget", () => {
    it("emits agent:end after run; final aggregate can be read from getUsageStats in handler", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      let finalStats: ReturnType<typeof getUsageStats> | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget({ onUpdate: () => {} });
          await promptAgent(schemas.simple);
          finalStats = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      const agentEnds = events.byType.get(EVENTS.AGENT_END) ?? [];
      expect(agentEnds.length).toBeGreaterThan(0);
      expect(agentEnds[0]).toMatchObject({
        type: EVENTS.AGENT_END,
        success: true,
        agentId: "test",
      });
      expect(finalStats).not.toBeNull();
      expect(finalStats!.aggregate.totalTokens).toBeGreaterThan(0);
    });
  });

  describe("onUpdate runs in parent context when triggered by child", () => {
    it("equipMemory inside onUpdate accesses the parent's own context, not the child's", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      let parentMemoryInOnUpdate: number | null = null;

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          // Child has its own separate memory
          const [childVal] = equipMemory("counter", 999);
          expect(childVal).toBe(999);
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          const [, setCounter] = equipMemory("counter", 0);
          setCounter(42);

          equipBudget({
            onUpdate: () => {
              // This should access the PARENT's memory, not the child's
              const [val, setVal] = equipMemory("counter", 0);
              parentMemoryInOnUpdate = val;
              setVal((prev) => prev + 1);
            },
          });

          // Parent's own prompt triggers onUpdate once
          await promptAgent(schemas.simple);
          // Child's prompt triggers onUpdate again (in parent ctx)
          await ChildAgent({});

          const [finalVal] = equipMemory("counter", 0);
          return { counterInParent: finalVal };
        },
      });

      const result = await ParentAgent({});

      // onUpdate was triggered at least once by child;
      // the first onUpdate (parent's own prompt) reads counter=42, sets to 43
      // the second onUpdate (child's prompt) reads counter=43, sets to 44
      expect(parentMemoryInOnUpdate).toBe(43);
      expect(result).toEqual({ counterInParent: 44 });
    });

    it("setMemory inside onUpdate persists across the parent agent's lifecycle", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 10, completionTokens: 5 });

      const updateLog: number[] = [];

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          equipMemory("update_count", 0);

          equipBudget({
            onUpdate: () => {
              const [count, setCount] = equipMemory("update_count", 0);
              updateLog.push(count);
              setCount(count + 1);
            },
          });

          await promptAgent(schemas.simple);
          await ChildAgent({});
          await ChildAgent({});

          const [finalCount] = equipMemory("update_count", 0);
          return { totalUpdates: finalCount };
        },
      });

      const result = await ParentAgent({});

      // 3 onUpdate calls: parent prompt + 2 child prompts
      expect(updateLog).toEqual([0, 1, 2]);
      expect(result).toEqual({ totalUpdates: 3 });
    });
  });

  describe("getUsageStats and onUpdate aggregate consistency", () => {
    it("getUsageStats().aggregate matches last onUpdate aggregate", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 100, completionTokens: 50 });

      let lastAggregate: {
        costs: { micro_usd?: number };
        totalTokens: number;
        callCount: number;
      } | null = null;
      let statsAtEnd: ReturnType<typeof getUsageStats> | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          equipBudget({
            onUpdate: (arg) => {
              lastAggregate = {
                costs: { ...arg.aggregate.costs },
                totalTokens: arg.aggregate.totalTokens,
                callCount: arg.aggregate.callCount,
              };
            },
          });
          await promptAgent(schemas.simple);
          statsAtEnd = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      expect(lastAggregate).not.toBeNull();
      expect(statsAtEnd).not.toBeNull();
      expect(statsAtEnd!.aggregate.costs).toEqual(lastAggregate!.costs);
      expect(statsAtEnd!.aggregate.totalTokens).toBe(lastAggregate!.totalTokens);
      expect(statsAtEnd!.aggregate.callCount).toBe(lastAggregate!.callCount);
    });
  });

  describe("calculateCost returns multiple billing keys", () => {
    it("aggregates micro_usd and credit from ModelAdapter.calculateCost into budget costs", async () => {
      const mock = createMockModel();
      mock.setCostCalculator((usage: TokenUsage): Record<string, number> => {
        const microUsd = Math.round(usage.promptTokens * 2 + usage.completionTokens * 3);
        const credit = Math.round(usage.totalTokens / 1000);
        if (microUsd === 0) return {};
        return { micro_usd: microUsd, credit };
      });
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
        });

      let stats: ReturnType<typeof getUsageStats> | null = null;

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

      // 1000*2 + 500*3 = 3500; credit = round(1500/1000) = 2
      expect(stats!.aggregate.costs.micro_usd).toBe(3500);
      expect(stats!.aggregate.costs.credit).toBe(2);

      const modelItem = stats!.aggregate.items.find((i) => i.type === "model");
      expect(modelItem).toBeDefined();
      expect(modelItem!.type === "model" && modelItem!.costs.micro_usd).toBe(3500);
      expect(modelItem!.type === "model" && modelItem!.costs.credit).toBe(2);
    });
  });

  describe("reasoning token and cache token merging", () => {
    it("accumulates reasoningTokens in details across multiple LLM calls", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({ promptTokens: 50, completionTokens: 30, details: { reasoningTokens: 100 } });

      let stats: ReturnType<typeof getUsageStats> | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [gen, setGen] = equipMemory("gen", 0);
          await promptAgent(schemas.simple);
          if (gen < 1) {
            setGen(gen + 1);
            return reborn();
          }
          stats = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      expect(stats!.aggregate.promptTokens).toBe(100);
      expect(stats!.aggregate.completionTokens).toBe(60);
      expect(stats!.aggregate.details?.reasoningTokens).toBe(200);

      const modelItem = stats!.aggregate.items.find((i) => i.type === "model");
      expect(modelItem).toBeDefined();
      expect(modelItem!.type === "model" && modelItem!.tokens.details?.reasoningTokens).toBe(200);
    });

    it("accumulates cacheReadTokens and cacheCreationTokens in details", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 80,
          completionTokens: 20,
          details: { cacheReadTokens: 500, cacheCreationTokens: 200 },
        });

      let stats: ReturnType<typeof getUsageStats> | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [gen, setGen] = equipMemory("gen", 0);
          await promptAgent(schemas.simple);
          if (gen < 1) {
            setGen(gen + 1);
            return reborn();
          }
          stats = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      expect(stats!.aggregate.details?.cacheReadTokens).toBe(1000);
      expect(stats!.aggregate.details?.cacheCreationTokens).toBe(400);

      const modelItem = stats!.aggregate.items.find((i) => i.type === "model");
      expect(modelItem!.type === "model" && modelItem!.tokens.details?.cacheReadTokens).toBe(1000);
      expect(modelItem!.type === "model" && modelItem!.tokens.details?.cacheCreationTokens).toBe(
        400,
      );
    });

    it("merges mixed details from different calls (reasoning + cache)", async () => {
      const mock = createMockModel();
      mock.sequence([
        { type: "json", content: { result: "ok" } },
        { type: "json", content: { result: "ok" } },
      ]);
      mock.setSequenceUsage([
        { promptTokens: 50, completionTokens: 20, details: { reasoningTokens: 100 } },
        { promptTokens: 60, completionTokens: 30, details: { cacheReadTokens: 300 } },
      ]);

      let stats: ReturnType<typeof getUsageStats> | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [gen, setGen] = equipMemory("gen", 0);
          await promptAgent(schemas.simple);
          if (gen < 1) {
            setGen(gen + 1);
            return reborn();
          }
          stats = getUsageStats();
          return { done: true };
        },
      });

      await agent({});

      expect(stats!.aggregate.promptTokens).toBe(110);
      expect(stats!.aggregate.completionTokens).toBe(50);
      expect(stats!.aggregate.details?.reasoningTokens).toBe(100);
      expect(stats!.aggregate.details?.cacheReadTokens).toBe(300);

      const modelItem = stats!.aggregate.items.find((i) => i.type === "model");
      expect(modelItem!.type === "model" && modelItem!.tokens.details?.reasoningTokens).toBe(100);
      expect(modelItem!.type === "model" && modelItem!.tokens.details?.cacheReadTokens).toBe(300);
    });

    it("merges child agent details into parent aggregate", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 40,
          completionTokens: 10,
          details: { reasoningTokens: 80, cacheReadTokens: 200 },
        });

      const ChildAgent = createAgent({
        id: "child",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      let parentStats: ReturnType<typeof getUsageStats> | null = null;

      const ParentAgent = createAgent({
        id: "parent",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          await ChildAgent({});
          parentStats = getUsageStats();
          return { done: true };
        },
      });

      await ParentAgent({});

      // Parent aggregate = own call + child call
      expect(parentStats!.aggregate.details?.reasoningTokens).toBe(160);
      expect(parentStats!.aggregate.details?.cacheReadTokens).toBe(400);
      // Parent own = only its own call
      expect(parentStats!.own.details?.reasoningTokens).toBe(80);
      expect(parentStats!.own.details?.cacheReadTokens).toBe(200);
    });
  });

  describe("invalid TokenUsage.details throws TypeError", () => {
    it("throws when details value is a string", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 10,
          completionTokens: 5,
          details: { badKey: "not_a_number" as any },
        });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(TypeError);
      await expect(agent({})).rejects.toThrow(/must be a finite number/);
    });

    it("throws when details value is NaN", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 10,
          completionTokens: 5,
          details: { badKey: NaN },
        });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(TypeError);
      await expect(agent({})).rejects.toThrow(/must be a finite number/);
    });

    it("throws when details value is Infinity", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 10,
          completionTokens: 5,
          details: { badKey: Infinity },
        });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(TypeError);
      await expect(agent({})).rejects.toThrow(/must be a finite number/);
    });

    it("throws with the offending key name in error message", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenReturn({ result: "ok" })
        .withUsage({
          promptTokens: 10,
          completionTokens: 5,
          details: { myCustomKey: {} as any },
        });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          await promptAgent(schemas.simple);
          return { done: true };
        },
      });

      await expect(agent({})).rejects.toThrow(/myCustomKey/);
    });
  });
});
