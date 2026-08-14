import { describe, expect, it } from "vitest";
import { emptySessionBudget } from "../../unified-conversation/budget";
import { formatSessionStatus } from "./format";

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
    expect(
      formatSessionStatus({
        sessionId: "s1",
        workspace: "/work/reagent",
        turns: 4,
        budget,
        modelId: "gpt-4o",
      }),
    ).toContain("OPENAI_CONTEXT_WINDOW");
  });

  it("reports when no model call has happened yet", () => {
    expect(
      formatSessionStatus({
        sessionId: "s1",
        workspace: "/work/reagent",
        turns: 0,
        budget: emptySessionBudget(),
        modelId: "gpt-4o",
      }),
    ).toContain("not measured yet");
  });
});
