import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSearchProvider: vi.fn(),
  getWebConfig: vi.fn(),
}));

vi.mock("./searchProvider", () => ({
  getSearchProvider: mocks.getSearchProvider,
  parseSearchQuery: () => ({ terms: "query", siteConstraint: null }),
  filterSearchResultsBySite: (results: unknown[]) => results,
}));
vi.mock("./webConfig", () => ({ getWebConfig: mocks.getWebConfig }));

import { webSearch } from "./index";

beforeEach(() => {
  mocks.getSearchProvider.mockReset();
  mocks.getWebConfig.mockReset();
  mocks.getSearchProvider.mockReturnValue({
    search: vi.fn().mockResolvedValue({
      provider: "llm:responses",
      requestedUrl: "https://search.example.test/v1/responses",
      finalUrl: "https://search.example.test/v1/responses",
      summary: "summary",
      results: [],
    }),
  });
});

describe("webSearch diagnostics", () => {
  it("reports the search proxy rather than the page-fetching proxy", async () => {
    mocks.getWebConfig.mockReturnValue({
      proxyUrl: "http://read-proxy.test:7070",
      llmSearchProxyUrl: null,
    });

    expect((await webSearch("query")).diagnostics.webProxyEnabled).toBe(false);

    mocks.getWebConfig.mockReturnValue({
      proxyUrl: null,
      llmSearchProxyUrl: "http://search-proxy.test:9090",
    });
    expect((await webSearch("query")).diagnostics.webProxyEnabled).toBe(true);
  });
});
