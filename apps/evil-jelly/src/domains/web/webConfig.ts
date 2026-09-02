/**
 * Web research substrate config: server-side search, page fetch, and outbound proxy settings.
 *
 * Reads only process.env (already populated by loadEvilJellyEnv per env-loading-policy); this layer
 * never opens its own .env file.
 */

import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
} from "../../shared/configuration/modelDefaults";

const DEFAULT_USER_AGENT = "rejelly-web-reader/0.1 (+https://github.com/waht41/rejelly)";

export interface WebConfig {
  userAgent: string;
  /** Per-request timeout in ms (search + fetch). */
  timeoutMs: number;
  /** Hard cap on a single fetched document body, in bytes (pre-sanitize). */
  maxFetchBytes: number;
  /** undici ProxyAgent target when proxying is enabled; null disables proxying. */
  proxyUrl: string | null;
  /** Explicit opt-in for the LLM-backed server-side search provider. */
  searchProvider: string;
  /**
   * LLM search provider (INV-0009 §3.1): use an OpenAI-compatible Responses endpoint by default,
   * with the former Anthropic Messages mirror retained behind an explicit protocol switch. Search
   * reuses the already-present OPENAI_* values as fallbacks, so the common setup needs no extra
   * credentials or model variables:
   *   - protocol: WEB_SEARCH_LLM_PROTOCOL → responses
   *   - key:   WEB_SEARCH_LLM_API_KEY → OPENAI_API_KEY
   *   - model: WEB_SEARCH_LLM_MODEL  → OPENAI_MODEL_ID
   *   - base:  WEB_SEARCH_LLM_BASE_URL → OPENAI_BASE_URL
   *
   * `responses` appends `/responses` to the configured OpenAI-compatible base. `anthropic` derives
   * `origin(OPENAI_BASE_URL) + /anthropic` and appends `/v1/messages`. An explicit base containing
   * an `/anthropic` path selects the legacy protocol when WEB_SEARCH_LLM_PROTOCOL is unset, keeping
   * existing profiles working.
   */
  llmSearchProtocol: string;
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
  const llmSearchProtocol = resolveLlmSearchProtocol();
  return {
    userAgent: (process.env.WEB_USER_AGENT ?? "").trim() || DEFAULT_USER_AGENT,
    timeoutMs: intFromEnv("WEB_TIMEOUT_MS", 15_000),
    maxFetchBytes: intFromEnv("WEB_MAX_FETCH_BYTES", 2_000_000),
    proxyUrl: resolveProxyUrl(),
    searchProvider: (process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase(),
    llmSearchProtocol,
    llmSearchBaseUrl: resolveLlmSearchBaseUrl(llmSearchProtocol),
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
 * Resolve the search protocol. Responses is the default; an explicit legacy `/anthropic` base is
 * also recognized so existing profiles do not silently start sending Messages-shaped requests to
 * the wrong endpoint.
 */
function resolveLlmSearchProtocol(): string {
  const explicit = (process.env.WEB_SEARCH_LLM_PROTOCOL ?? "").trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const explicitBase = (process.env.WEB_SEARCH_LLM_BASE_URL ?? "").trim();
  try {
    if (new URL(explicitBase).pathname.split("/").includes("anthropic")) {
      return "anthropic";
    }
  } catch {
    // A malformed base is reported by the provider; it must not change the protocol default.
  }
  return "responses";
}

/** Resolve the protocol-specific root to which the provider appends its endpoint path. */
function resolveLlmSearchBaseUrl(protocol: string): string {
  const explicit = (process.env.WEB_SEARCH_LLM_BASE_URL ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const openaiBase = (process.env.OPENAI_BASE_URL ?? "").trim() || DEFAULT_OPENAI_BASE_URL;
  if (protocol !== "anthropic") {
    return openaiBase.replace(/\/+$/, "");
  }
  try {
    return `${new URL(openaiBase).origin}/anthropic`;
  } catch {
    return "";
  }
}
