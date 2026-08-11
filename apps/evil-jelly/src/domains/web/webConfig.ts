/**
 * Web research substrate config: server-side search, page fetch, and outbound proxy settings.
 *
 * Reads only process.env (already populated by loadEvilJellyEnv per env-loading-policy); this layer
 * never opens its own .env file.
 */

import { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL_ID } from "../../shared/configDefaults";

const DEFAULT_USER_AGENT = "rejelly-web-reader/0.1 (+https://github.com/waht41/rejelly)";

export interface WebConfig {
  userAgent: string;
  /** Per-request timeout in ms (search + fetch). */
  timeoutMs: number;
  /** Hard cap on a single fetched document body, in bytes (pre-sanitize). */
  maxFetchBytes: number;
  /** undici ProxyAgent target when proxying is enabled; null disables proxying. */
  proxyUrl: string | null;
  /** Explicit opt-in for the Anthropic-compatible server-side search provider. */
  searchProvider: string;
  /**
   * LLM search provider (INV-0009 §3.1): a CC-compatible model's Anthropic-mirror endpoint that
   * proxies Anthropic's server-side `web_search` tool. No vendor literals in source — any domestic
   * mirror (DeepSeek, Qwen, Zhipu, ...) drops in by env alone. To keep config minimal, all three
   * reuse the already-present OPENAI_* (single-vendor) values as the fallback, so the common
   * setup needs no extra search-specific variables:
   *   - key:   WEB_SEARCH_LLM_API_KEY → OPENAI_API_KEY
   *   - model: WEB_SEARCH_LLM_MODEL  → OPENAI_MODEL_ID
   *   - base:  WEB_SEARCH_LLM_BASE_URL → origin(OPENAI_BASE_URL) + "/anthropic"
   * base is the `/anthropic` root (we append `/v1/messages`). Derivation assumes the OpenAI-protocol
   * host also exposes an Anthropic mirror at /anthropic (true for DeepSeek); set the explicit var to
   * override when it doesn't.
   */
  llmSearchBaseUrl: string;
  llmSearchApiKey: string;
  llmSearchModel: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Web egress proxy is a SEPARATE knob from the global USE_PROXY/PROXY_URL (which routes the LLM API).
 * Defaults to DIRECT. Opt in with WEB_PROXY_URL, or WEB_USE_PROXY=true to reuse PROXY_URL.
 */
function resolveProxyUrl(): string | null {
  const explicit = (process.env.WEB_PROXY_URL ?? "").trim();
  if (explicit.length > 0) {
    return explicit;
  }
  const reuseGlobal = (process.env.WEB_USE_PROXY ?? "").trim().toLowerCase() === "true";
  if (reuseGlobal) {
    const url = (process.env.PROXY_URL ?? "").trim();
    return url.length > 0 ? url : null;
  }
  return null;
}

export function getWebConfig(): WebConfig {
  return {
    userAgent: (process.env.WEB_USER_AGENT ?? "").trim() || DEFAULT_USER_AGENT,
    timeoutMs: intFromEnv("WEB_TIMEOUT_MS", 15_000),
    maxFetchBytes: intFromEnv("WEB_MAX_FETCH_BYTES", 2_000_000),
    proxyUrl: resolveProxyUrl(),
    searchProvider: (process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase(),
    llmSearchBaseUrl: resolveLlmSearchBaseUrl(),
    llmSearchApiKey:
      (process.env.WEB_SEARCH_LLM_API_KEY ?? "").trim() ||
      (process.env.OPENAI_API_KEY ?? "").trim(),
    llmSearchModel:
      (process.env.WEB_SEARCH_LLM_MODEL ?? "").trim() ||
      (process.env.OPENAI_MODEL_ID ?? "").trim() ||
      DEFAULT_OPENAI_MODEL_ID,
  };
}

/** Whether server-side web search was explicitly enabled at tool-registration time. */
export function isWebSearchConfigured(): boolean {
  return getWebConfig().searchProvider === "llm";
}

/**
 * Resolve the Anthropic-mirror base for LLM search. Explicit WEB_SEARCH_LLM_BASE_URL wins; otherwise
 * derive it from the OpenAI-protocol base by keeping the host and swapping the path to /anthropic
 * (e.g. https://api.deepseek.com/v1 → https://api.deepseek.com/anthropic).
 */
function resolveLlmSearchBaseUrl(): string {
  const explicit = (process.env.WEB_SEARCH_LLM_BASE_URL ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const openaiBase = (process.env.OPENAI_BASE_URL ?? "").trim() || DEFAULT_OPENAI_BASE_URL;
  try {
    return `${new URL(openaiBase).origin}/anthropic`;
  } catch {
    return "";
  }
}
