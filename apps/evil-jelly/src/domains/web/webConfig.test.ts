import { afterEach, describe, expect, it, vi } from "vitest";
import { getWebConfig, isWebSearchConfigured } from "./webConfig";

const SEARCH_ENV_NAMES = [
  "WEB_SEARCH_PROVIDER",
  "WEB_SEARCH_LLM_PROTOCOL",
  "WEB_SEARCH_LLM_BASE_URL",
  "WEB_SEARCH_LLM_API_KEY",
  "WEB_SEARCH_LLM_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL_ID",
  "WEB_TIMEOUT_MS",
  "WEB_MAX_FETCH_BYTES",
] as const;

function clearSearchEnv(): void {
  for (const name of SEARCH_ENV_NAMES) {
    vi.stubEnv(name, "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isWebSearchConfigured", () => {
  it("is disabled when no provider is selected", () => {
    clearSearchEnv();

    expect(isWebSearchConfigured()).toBe(false);
  });

  it("is enabled only when the llm provider is selected", () => {
    clearSearchEnv();
    vi.stubEnv("WEB_SEARCH_PROVIDER", " LLM ");

    expect(isWebSearchConfigured()).toBe(true);
  });

  it("does not infer enablement from endpoint configuration", () => {
    clearSearchEnv();
    vi.stubEnv("WEB_SEARCH_PROVIDER", "other");
    vi.stubEnv("WEB_SEARCH_LLM_BASE_URL", "https://api.example.test/anthropic");
    vi.stubEnv("WEB_SEARCH_LLM_API_KEY", "test-key");
    vi.stubEnv("WEB_SEARCH_LLM_MODEL", "test-model");

    expect(isWebSearchConfigured()).toBe(false);
  });
});

describe("getWebConfig", () => {
  it("inherits the main LLM built-in defaults when search-specific values are absent", () => {
    clearSearchEnv();

    const config = getWebConfig();

    expect(config.llmSearchProtocol).toBe("responses");
    expect(config.llmSearchBaseUrl).toBe("https://api.openai.com/v1");
    expect(config.llmSearchModel).toBe("gpt-5.6-luna");
  });

  it("derives search values from explicit main LLM configuration", () => {
    clearSearchEnv();
    vi.stubEnv("OPENAI_BASE_URL", "https://api.main.test/v1");
    vi.stubEnv("OPENAI_API_KEY", "main-key");
    vi.stubEnv("OPENAI_MODEL_ID", "main-model");

    const config = getWebConfig();

    expect(config.llmSearchProtocol).toBe("responses");
    expect(config.llmSearchBaseUrl).toBe("https://api.main.test/v1");
    expect(config.llmSearchApiKey).toBe("main-key");
    expect(config.llmSearchModel).toBe("main-model");
  });

  it("prefers explicit search values over the main LLM configuration", () => {
    clearSearchEnv();
    vi.stubEnv("OPENAI_BASE_URL", "https://api.main.test/v1");
    vi.stubEnv("OPENAI_MODEL_ID", "main-model");
    vi.stubEnv("WEB_SEARCH_LLM_BASE_URL", "https://api.search.test/v1");
    vi.stubEnv("WEB_SEARCH_LLM_MODEL", "search-model");

    const config = getWebConfig();

    expect(config.llmSearchProtocol).toBe("responses");
    expect(config.llmSearchBaseUrl).toBe("https://api.search.test/v1");
    expect(config.llmSearchModel).toBe("search-model");
  });

  it("recognizes an existing explicit Anthropic mirror base", () => {
    clearSearchEnv();
    vi.stubEnv("WEB_SEARCH_LLM_BASE_URL", "https://api.search.test/anthropic");

    const config = getWebConfig();

    expect(config.llmSearchProtocol).toBe("anthropic");
    expect(config.llmSearchBaseUrl).toBe("https://api.search.test/anthropic");
  });

  it("derives the Anthropic mirror when that protocol is explicitly selected", () => {
    clearSearchEnv();
    vi.stubEnv("OPENAI_BASE_URL", "https://api.main.test/v1");
    vi.stubEnv("WEB_SEARCH_LLM_PROTOCOL", "anthropic");

    const config = getWebConfig();

    expect(config.llmSearchProtocol).toBe("anthropic");
    expect(config.llmSearchBaseUrl).toBe("https://api.main.test/anthropic");
  });

  it("falls back for malformed or non-integer numeric values", () => {
    clearSearchEnv();
    vi.stubEnv("WEB_TIMEOUT_MS", "12ms");
    vi.stubEnv("WEB_MAX_FETCH_BYTES", "1.5");

    const config = getWebConfig();

    expect(config.timeoutMs).toBe(15_000);
    expect(config.maxFetchBytes).toBe(2_000_000);
  });
});
