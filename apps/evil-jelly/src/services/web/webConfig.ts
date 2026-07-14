/**
 * Web research substrate config: scrape parameters + outbound proxy, resolved from process.env.
 *
 * Reads only process.env (already populated by loadEvilJellyEnv per env-loading-policy); this layer
 * never opens its own .env file. All knobs have safe MVP defaults so the kit runs with zero config.
 */

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Bing SERP host. Mainland networks resolve www.bing.com to cn.bing.com automatically. */
const DEFAULT_SEARCH_BASE = "https://www.bing.com/search";

export interface WebConfig {
  userAgent: string;
  /** Per-request timeout in ms (search + fetch). */
  timeoutMs: number;
  /** Hard cap on a single fetched document body, in bytes (pre-sanitize). */
  maxFetchBytes: number;
  /** Bing market hint, e.g. en-US / zh-CN. Empty leaves it to Bing geo-detection. */
  market: string;
  searchBaseUrl: string;
  /** undici ProxyAgent target when proxying is enabled; null disables proxying. */
  proxyUrl: string | null;
  /** Active search provider: "bing" (SERP scrape) or "llm" (Anthropic-mirror web_search tool). */
  searchProvider: string;
  /**
   * LLM search provider (INV-0009 §3.1): a CC-compatible model's Anthropic-mirror endpoint that
   * proxies Anthropic's server-side `web_search` tool. No vendor literals in source — any domestic
   * mirror (DeepSeek, Qwen, Zhipu, ...) drops in by env alone. To keep config minimal, all three
   * reuse the already-present OPENAI_* (single-vendor) values as the fallback, so the common
   * setup needs only WEB_SEARCH_PROVIDER=llm:
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
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Web egress proxy is a SEPARATE knob from the global USE_PROXY/PROXY_URL (which routes the LLM API).
 * Defaults to DIRECT: Bing serves decoy/unrelated results to flagged proxy exit IPs, and Bing is
 * directly reachable on the target network, so proxying the SERP actively breaks search quality.
 * Opt in only for page fetches that need it: set WEB_PROXY_URL, or WEB_USE_PROXY=true to reuse PROXY_URL.
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
    market: (process.env.WEB_SEARCH_MARKET ?? "").trim(),
    searchBaseUrl: (process.env.WEB_SEARCH_BASE_URL ?? "").trim() || DEFAULT_SEARCH_BASE,
    proxyUrl: resolveProxyUrl(),
    searchProvider: (process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase() || "bing",
    llmSearchBaseUrl: resolveLlmSearchBaseUrl(),
    llmSearchApiKey:
      (process.env.WEB_SEARCH_LLM_API_KEY ?? "").trim() ||
      (process.env.OPENAI_API_KEY ?? "").trim(),
    llmSearchModel:
      (process.env.WEB_SEARCH_LLM_MODEL ?? "").trim() || (process.env.OPENAI_MODEL_ID ?? "").trim(),
  };
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
  const openaiBase = (process.env.OPENAI_BASE_URL ?? "").trim();
  if (!openaiBase) {
    return "";
  }
  try {
    return `${new URL(openaiBase).origin}/anthropic`;
  } catch {
    return "";
  }
}
