import { afterEach, describe, expect, it, vi } from "vitest";
import { isWebSearchConfigured } from "./webConfig";

const SEARCH_ENV_NAMES = [
  "WEB_SEARCH_PROVIDER",
  "WEB_SEARCH_LLM_BASE_URL",
  "WEB_SEARCH_LLM_API_KEY",
  "WEB_SEARCH_LLM_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL_ID",
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
