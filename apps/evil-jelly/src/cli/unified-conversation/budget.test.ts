import type { UsageStats } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { combineSessionBudget, emptySessionBudget } from "./budget";

function aggregate(partial: Partial<UsageStats>): UsageStats {
  return {
    costs: {},
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    callCount: 0,
    items: [],
    ...partial,
  };
}

describe("combineSessionBudget", () => {
  it("sums tokens/costs/cache onto the resumed base", () => {
    const base = {
      ...emptySessionBudget(),
      totalTokens: 100,
      promptTokens: 80,
      completionTokens: 20,
      cacheReadTokens: 50,
      callCount: 2,
      costs: { micro_usd: 5000 },
      lastContextTokens: 80,
    };
    const combined = combineSessionBudget(
      base,
      aggregate({
        totalTokens: 50,
        promptTokens: 40,
        completionTokens: 10,
        callCount: 1,
        costs: { micro_usd: 3000 },
        details: { cacheReadTokens: 30 },
      }),
      { contextTokens: 120, cacheReadTokens: 25 },
    );
    expect(combined).toMatchObject({
      totalTokens: 150,
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 80,
      callCount: 3,
      costs: { micro_usd: 8000 },
    });
  });

  it("takes the last-call snapshot as-is, not a sum", () => {
    const base = { ...emptySessionBudget(), lastContextTokens: 80, lastCacheReadTokens: 40 };
    const combined = combineSessionBudget(base, aggregate({ promptTokens: 200 }), {
      contextTokens: 120,
      cacheReadTokens: 25,
    });
    expect(combined.lastContextTokens).toBe(120);
    expect(combined.lastCacheReadTokens).toBe(25);
  });

  it("treats a missing base as zero", () => {
    const combined = combineSessionBudget(undefined, aggregate({ totalTokens: 42 }), {
      contextTokens: 10,
      cacheReadTokens: 0,
    });
    expect(combined.totalTokens).toBe(42);
    expect(combined.cacheReadTokens).toBe(0);
    expect(combined.costs).toEqual({});
  });
});
