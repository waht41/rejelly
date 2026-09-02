import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  getWebConfig: vi.fn(),
}));

vi.mock("./httpClient", () => ({
  fetchJson: mocks.fetchJson,
  HttpError: class HttpError extends Error {
    constructor(
      message: string,
      readonly status?: number,
      readonly responseBody?: unknown,
    ) {
      super(message);
    }
  },
}));
vi.mock("./webConfig", () => ({ getWebConfig: mocks.getWebConfig }));

import { HttpError } from "./httpClient";
import { LlmSearchProvider } from "./searchProvider";

const baseConfig = {
  llmSearchApiKey: "search-key",
  llmSearchModel: "search-model",
  llmSearchProxyUrl: "http://search-proxy.test:9090",
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
        model: "resolved-search-model",
        provider: "OpenRouter",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 8 },
          server_tool_use: { web_search_requests: 2 },
          cost: 0.0120438,
        },
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
        proxyUrl: "http://search-proxy.test:9090",
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
      usage: {
        costs: { micro_usd: 12_044 },
        searchRequests: 2,
        modelUsages: [
          {
            provider: "openrouter",
            model: "resolved-search-model",
            usage: {
              promptTokens: 100,
              completionTokens: 20,
              totalTokens: 120,
              details: {
                cacheReadTokens: 40,
                cacheWriteTokens: 5,
                reasoningTokens: 8,
              },
            },
          },
        ],
      },
    });
  });

  it("keeps the Anthropic Messages request behind the explicit legacy protocol", async () => {
    mocks.getWebConfig.mockReturnValue({
      ...baseConfig,
      llmSearchProtocol: "anthropic",
      llmSearchBaseUrl: "https://api.example.test/anthropic",
    });
    mocks.fetchJson.mockResolvedValue({
      status: 200,
      json: {
        model: "resolved-anthropic-model",
        usage: {
          input_tokens: 80,
          output_tokens: 15,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 4,
          server_tool_use: { web_search_requests: 1 },
        },
        content: [],
      },
    });

    const response = await new LlmSearchProvider().search("legacy search");

    expect(mocks.fetchJson).toHaveBeenCalledWith(
      "https://api.example.test/anthropic/v1/messages",
      expect.objectContaining({
        headers: { "x-api-key": "search-key", "anthropic-version": "2023-06-01" },
        proxyUrl: "http://search-proxy.test:9090",
      }),
    );
    expect(response).toMatchObject({
      provider: "llm:anthropic",
      summary: "",
      results: [],
      usage: {
        costs: {},
        searchRequests: 1,
        modelUsages: [
          {
            provider: "api.example.test",
            model: "resolved-anthropic-model",
            usage: {
              promptTokens: 80,
              completionTokens: 15,
              totalTokens: 95,
              details: { cacheReadTokens: 30, cacheWriteTokens: 4 },
            },
          },
        ],
      },
    });
  });

  it("retries without complete sources and caches that endpoint capability", async () => {
    mocks.getWebConfig.mockReturnValue({
      ...baseConfig,
      llmSearchProtocol: "responses",
      llmSearchBaseUrl: "https://compatible.example.test/v1",
    });
    const unsupportedInclude = new HttpError("HTTP 400", 400, {
      error: { code: "invalid_prompt", message: "Invalid Responses API request" },
      metadata: {
        raw: JSON.stringify([
          {
            code: "invalid_value",
            values: ["file_search_call.results", "reasoning.encrypted_content"],
            path: ["include", 0],
            message: "Invalid option: expected one of the supported include values",
          },
        ]),
      },
    });
    mocks.fetchJson
      .mockRejectedValueOnce(unsupportedInclude)
      .mockResolvedValue({ status: 200, json: { output: [] } });
    const provider = new LlmSearchProvider();

    await provider.search("first query");
    await provider.search("second query");

    expect(mocks.fetchJson).toHaveBeenCalledTimes(3);
    expect(mocks.fetchJson).toHaveBeenNthCalledWith(
      1,
      "https://compatible.example.test/v1/responses",
      expect.objectContaining({
        body: expect.objectContaining({
          include: ["web_search_call.action.sources"],
        }),
      }),
    );
    for (const callIndex of [1, 2]) {
      const options = mocks.fetchJson.mock.calls[callIndex]?.[1] as {
        body?: Record<string, unknown>;
      };
      expect(options.body).not.toHaveProperty("include");
    }
  });

  it("does not retry unrelated Responses validation errors", async () => {
    mocks.getWebConfig.mockReturnValue({
      ...baseConfig,
      llmSearchProtocol: "responses",
      llmSearchBaseUrl: "https://api.example.test/v1",
    });
    const unrelatedError = new HttpError("HTTP 400", 400, {
      error: { code: "invalid_prompt" },
      metadata: { raw: '[{"path":["max_output_tokens"],"code":"invalid_value"}]' },
    });
    mocks.fetchJson.mockRejectedValueOnce(unrelatedError);

    await expect(new LlmSearchProvider().search("x")).rejects.toBe(unrelatedError);
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
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
