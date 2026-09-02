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
  /** Proxy for page fetching; inherits the shared web/Chat proxy unless explicitly overridden. */
  proxyUrl: string | null;
  /** Proxy for the LLM search API; inherits the main Chat proxy unless explicitly overridden. */
  llmSearchProxyUrl: string | null;
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

type ProxyOverride = string | null | undefined;

/** Unset inherits, `direct` forces direct access, and every other value is a proxy URL. */
function readProxyOverride(name: string): ProxyOverride {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    return undefined;
  }
  return value.toLowerCase() === "direct" ? null : value;
}

/** Shared web default: an explicit web setting, then the effective Chat proxy, then direct. */
function resolveSharedWebProxyUrl(): string | null {
  const explicit = readProxyOverride("WEB_PROXY_URL");
  if (explicit !== undefined) {
    return explicit;
  }
  return resolveChatProxyUrl();
}

/** A page-specific URL is the only difference from the shared web proxy policy. */
function resolveReadProxyUrl(): string | null {
  const explicit = readProxyOverride("WEB_READ_PROXY_URL");
  return explicit === undefined ? resolveSharedWebProxyUrl() : explicit;
}

function resolveChatProxyUrl(): string | null {
  const enabled = process.env.USE_PROXY === "true" || process.env.USE_PROXY === "1";
  if (!enabled) {
    return null;
  }
  return (
    (process.env.HTTPS_PROXY ?? "").trim() ||
    (process.env.HTTP_PROXY ?? "").trim() ||
    (process.env.PROXY_URL ?? "").trim() ||
    "http://127.0.0.1:7890"
  );
}

/**
 * Server-side search follows the shared web proxy by default. Its own tri-state setting can select
 * a different proxy or force direct access without affecting page fetching.
 */
function resolveLlmSearchProxyUrl(): string | null {
  const explicit = readProxyOverride("WEB_SEARCH_LLM_PROXY_URL");
  return explicit === undefined ? resolveSharedWebProxyUrl() : explicit;
}

export function getWebConfig(): WebConfig {
  const llmSearchProtocol = resolveLlmSearchProtocol();
  return {
    userAgent: (process.env.WEB_USER_AGENT ?? "").trim() || DEFAULT_USER_AGENT,
    timeoutMs: intFromEnv("WEB_TIMEOUT_MS", 15_000),
    maxFetchBytes: intFromEnv("WEB_MAX_FETCH_BYTES", 2_000_000),
    proxyUrl: resolveReadProxyUrl(),
    llmSearchProxyUrl: resolveLlmSearchProxyUrl(),
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
