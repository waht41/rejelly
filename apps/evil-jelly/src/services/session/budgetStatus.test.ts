import type { UsageStats } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { combineSessionBudget, emptySessionBudget, formatSessionStatus } from "./budgetStatus";

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
    expect(combined.totalTokens).toBe(150);
    expect(combined.promptTokens).toBe(120);
    expect(combined.completionTokens).toBe(30);
    expect(combined.cacheReadTokens).toBe(80);
    expect(combined.callCount).toBe(3);
    expect(combined.costs).toEqual({ micro_usd: 8000 });
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

describe("formatSessionStatus", () => {
  const budget = {
    ...emptySessionBudget(),
    totalTokens: 45600,
    promptTokens: 40100,
    completionTokens: 5500,
    cacheReadTokens: 30200,
    callCount: 12,
    costs: { micro_usd: 123400 },
    lastContextTokens: 12300,
    lastCacheReadTokens: 8100,
  };

  it("shows remaining and cache when the context window is known", () => {
    const out = formatSessionStatus({
      sessionId: "s1",
      workspace: "/work/reagent",
      turns: 4,
      budget,
      modelId: "gpt-4o",
      contextWindow: 128000,
    });
    expect(out).toContain("12.3k / 128.0k");
    expect(out).toContain("- Workspace: /work/reagent");
    expect(out).toContain("% used");
    expect(out).toContain("8.1k cached");
    expect(out).toContain("cached 30.2k");
    expect(out).toContain("$0.1234");
  });

  it("omits remaining and hints at the env var when the window is unknown", () => {
    const out = formatSessionStatus({
      sessionId: "s1",
      workspace: "/work/reagent",
      turns: 4,
      budget,
      modelId: "gpt-4o",
    });
    expect(out).toContain("OPENAI_CONTEXT_WINDOW");
  });

  it("reports when no model call has happened yet", () => {
    const out = formatSessionStatus({
      sessionId: "s1",
      workspace: "/work/reagent",
      turns: 0,
      budget: emptySessionBudget(),
      modelId: "gpt-4o",
    });
    expect(out).toContain("not measured yet");
  });
});
