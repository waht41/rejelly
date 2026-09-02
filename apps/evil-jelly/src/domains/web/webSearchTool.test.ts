import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  equipTraceAttr: vi.fn(),
  recordToolUsage: vi.fn(),
  webSearch: vi.fn(),
}));

vi.mock("@rejelly/core", () => ({
  equipTraceAttr: mocks.equipTraceAttr,
  recordToolUsage: mocks.recordToolUsage,
}));
vi.mock("./index", () => ({
  webSearch: mocks.webSearch,
  HttpError: class HttpError extends Error {},
}));

import { WebSearchTool } from "./webSearchTool";

beforeEach(() => {
  mocks.equipTraceAttr.mockReset();
  mocks.recordToolUsage.mockReset();
  mocks.webSearch.mockReset();
});

describe("WebSearchTool usage accounting", () => {
  it("records one tool usage from the successful provider response without duplicating cost", async () => {
    mocks.webSearch.mockResolvedValue({
      summary: "Grounded summary.",
      results: [],
      diagnostics: {
        provider: "llm:responses",
        requestedHost: "openrouter.ai",
        finalHost: "openrouter.ai",
        webProxyEnabled: true,
        rawResultCount: 0,
        resultCount: 0,
        topHosts: [],
        siteConstraint: null,
      },
      usage: {
        costs: { micro_usd: 12_044 },
        searchRequests: 1,
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
        ],
      },
    });

    await WebSearchTool.handler({ query: "query" });

    expect(mocks.recordToolUsage).toHaveBeenCalledOnce();
    expect(mocks.recordToolUsage).toHaveBeenCalledWith({
      name: "web_search",
      quantity: 1,
      unit: "request",
      costs: { micro_usd: 12_044 },
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
      ],
      details: { provider: "llm:responses" },
    });
  });

  it("does not record usage when the provider omits usage or the search fails", async () => {
    mocks.webSearch.mockResolvedValueOnce({
      summary: "summary",
      results: [],
      diagnostics: {
        provider: "llm:responses",
        requestedHost: "example.test",
        finalHost: "example.test",
        webProxyEnabled: false,
        rawResultCount: 0,
        resultCount: 0,
        topHosts: [],
        siteConstraint: null,
      },
    });
    await WebSearchTool.handler({ query: "no usage" });

    mocks.webSearch.mockRejectedValueOnce(new Error("unavailable"));
    await expect(WebSearchTool.handler({ query: "failed" })).resolves.toContain(
      "web_search failed",
    );

    expect(mocks.recordToolUsage).not.toHaveBeenCalled();
  });
});
