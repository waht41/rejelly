import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  getWebConfig: vi.fn(),
}));

vi.mock("./httpClient", () => ({
  fetchJson: mocks.fetchJson,
  HttpError: class HttpError extends Error {},
}));
vi.mock("./webConfig", () => ({ getWebConfig: mocks.getWebConfig }));

import { LlmSearchProvider } from "./searchProvider";

const baseConfig = {
  llmSearchApiKey: "search-key",
  llmSearchModel: "search-model",
};

beforeEach(() => {
  mocks.fetchJson.mockReset();
  mocks.getWebConfig.mockReset();
});

describe("LlmSearchProvider requests", () => {
  it("uses the Responses web_search tool and maps site: to an allowed-domain filter", async () => {
    mocks.getWebConfig.mockReturnValue({
      ...baseConfig,
      llmSearchProtocol: "responses",
      llmSearchBaseUrl: "https://api.example.test/v1/",
    });
    mocks.fetchJson.mockResolvedValue({
      status: 200,
      json: {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Grounded summary.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://docs.example.test/search",
                    title: "Search docs",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const response = await new LlmSearchProvider().search(
      "site:docs.example.test Responses search",
    );

    expect(mocks.fetchJson).toHaveBeenCalledWith(
      "https://api.example.test/v1/responses",
      expect.objectContaining({
        headers: { Authorization: "Bearer search-key" },
        body: expect.objectContaining({
          model: "search-model",
          tool_choice: "required",
          include: ["web_search_call.action.sources"],
          tools: [
            {
              type: "web_search",
              search_context_size: "low",
              filters: { allowed_domains: ["docs.example.test"] },
            },
          ],
        }),
        timeoutMs: 60_000,
      }),
    );
    expect(response).toMatchObject({
      provider: "llm:responses",
      summary: "Grounded summary.",
      results: [
        {
          title: "Search docs",
          url: "https://docs.example.test/search",
          snippet: "",
        },
      ],
    });
  });

  it("keeps the Anthropic Messages request behind the explicit legacy protocol", async () => {
    mocks.getWebConfig.mockReturnValue({
      ...baseConfig,
      llmSearchProtocol: "anthropic",
      llmSearchBaseUrl: "https://api.example.test/anthropic",
    });
    mocks.fetchJson.mockResolvedValue({ status: 200, json: { content: [] } });

    const response = await new LlmSearchProvider().search("legacy search");

    expect(mocks.fetchJson).toHaveBeenCalledWith(
      "https://api.example.test/anthropic/v1/messages",
      expect.objectContaining({
        headers: { "x-api-key": "search-key", "anthropic-version": "2023-06-01" },
      }),
    );
    expect(response).toMatchObject({
      provider: "llm:anthropic",
      summary: "",
      results: [],
    });
  });

  it("rejects unknown protocols instead of guessing an endpoint", async () => {
    mocks.getWebConfig.mockReturnValue({
      ...baseConfig,
      llmSearchProtocol: "response",
      llmSearchBaseUrl: "https://api.example.test/v1",
    });

    await expect(new LlmSearchProvider().search("x")).rejects.toThrow(
      'unsupported WEB_SEARCH_LLM_PROTOCOL "response"',
    );
    expect(mocks.fetchJson).not.toHaveBeenCalled();
  });
});
