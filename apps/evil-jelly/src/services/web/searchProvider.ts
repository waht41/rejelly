/**
 * Search provider behind an interface so the SERP source is swappable (INV-0009 §3.1).
 *
 * Default = BingSearchProvider: scrape the Bing HTML results page (no API key / no vendor binding;
 * Bing's SERP is relatively scrape-tolerant). GoogleSearchProvider is the planned second provider;
 * the reversal trigger to a paid API (Brave/Serper/CSE) is recorded in the INV, not coded here.
 */

import { fetchJson, fetchText, HttpError } from "./httpClient";
import { stripTags } from "./sanitize";
import { getWebConfig } from "./webConfig";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchProviderResponse>;
}

export interface SearchProviderResponse {
  provider: string;
  requestedUrl: string;
  finalUrl: string;
  results: SearchResult[];
}

/** Bing wraps some outbound links in a redirector; unwrap the real target when present. */
function unwrapBingUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (/bing\.com$/i.test(u.hostname)) {
      const real = u.searchParams.get("u") ?? u.searchParams.get("r");
      if (real) {
        // Bing's `u` param is sometimes base64 (prefixed "a1") of the URL.
        const candidate = real.startsWith("a1") ? safeBase64(real.slice(2)) : real;
        if (candidate?.startsWith("http")) {
          return candidate;
        }
      }
    }
  } catch {
    // not an absolute URL — fall through
  }
  return raw;
}

function safeBase64(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export class BingSearchProvider implements SearchProvider {
  readonly name = "bing";

  async search(query: string, limit: number): Promise<SearchProviderResponse> {
    const config = getWebConfig();
    const params = new URLSearchParams({ q: query, count: String(Math.min(limit * 2, 30)) });
    if (config.market) {
      params.set("mkt", config.market);
    }
    const url = `${config.searchBaseUrl}?${params.toString()}`;
    const { body, url: finalUrl } = await fetchText(url, { acceptHtmlOnly: true });
    return {
      provider: this.name,
      requestedUrl: url,
      finalUrl,
      results: parseBingResults(body, limit),
    };
  }
}

/** Parse <li class="b_algo"> blocks: title + url from the <h2><a>, snippet from the first <p>. */
export function parseBingResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const blockRe = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;

  for (const block of html.matchAll(blockRe)) {
    const segment = block[1];
    const anchor = segment.match(
      /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!anchor) {
      continue;
    }
    const url = unwrapBingUrl(decodeHref(anchor[1]));
    if (!url.startsWith("http") || seen.has(url)) {
      continue;
    }
    const title = stripTags(anchor[2]);
    if (!title) {
      continue;
    }
    const snippetMatch =
      segment.match(/<p\b[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
      segment.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";

    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function decodeHref(raw: string): string {
  return raw.replace(/&amp;/g, "&");
}

/**
 * LLM-API search provider: call a CC-compatible model's Anthropic-mirror endpoint with Anthropic's
 * server-side `web_search` tool and harvest the result blocks (INV-0009 §3.1). Verified against
 * DeepSeek's /anthropic endpoint: on English/technical/rare queries it returns relevant first-party
 * sources where the cn.bing SERP scrape was polluted. We extract clean {title,url}; the per-result
 * body is Anthropic's opaque `encrypted_content`, so snippet is left empty (read_webpage fetches the
 * real text). `site:` is not honored by the mirror — prefer plain keywords + post-hoc host filtering.
 */
export class LlmSearchProvider implements SearchProvider {
  readonly name = "llm";

  async search(query: string, limit: number): Promise<SearchProviderResponse> {
    const config = getWebConfig();
    if (!config.llmSearchApiKey) {
      throw new HttpError("WEB_SEARCH_LLM_API_KEY (or OPENAI_API_KEY) is not set");
    }
    if (!config.llmSearchBaseUrl) {
      throw new HttpError("WEB_SEARCH_LLM_BASE_URL is not set");
    }
    if (!config.llmSearchModel) {
      throw new HttpError("WEB_SEARCH_LLM_MODEL (or OPENAI_MODEL_ID) is not set");
    }
    const url = `${config.llmSearchBaseUrl.replace(/\/+$/, "")}/v1/messages`;
    const { json } = await fetchJson(url, {
      headers: { "x-api-key": config.llmSearchApiKey, "anthropic-version": "2023-06-01" },
      body: {
        model: config.llmSearchModel,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              "You must call the web_search tool to find sources for the query below, then stop. " +
              `Do not answer from memory.\n\nQuery: ${query}`,
          },
        ],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      },
      // Model turn + server-side search: well past the 15s SERP/fetch default.
      timeoutMs: 60_000,
    });
    return {
      provider: this.name,
      requestedUrl: url,
      finalUrl: url,
      results: parseAnthropicWebSearch(json, limit),
    };
  }
}

/** Harvest `web_search_result` items from an Anthropic Messages response into SearchResult[]. */
export function parseAnthropicWebSearch(json: unknown, limit: number): SearchResult[] {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const block of content) {
    if (
      (block as { type?: unknown })?.type !== "web_search_tool_result" ||
      !Array.isArray((block as { content?: unknown }).content)
    ) {
      continue;
    }
    for (const item of (block as { content: unknown[] }).content) {
      const r = item as { type?: unknown; url?: unknown; title?: unknown };
      if (r.type !== "web_search_result" || typeof r.url !== "string" || seen.has(r.url)) {
        continue;
      }
      seen.add(r.url);
      // Per-result body is Anthropic's opaque encrypted_content → no plain snippet to surface.
      results.push({
        title: typeof r.title === "string" ? r.title : r.url,
        url: r.url,
        snippet: "",
      });
      if (results.length >= limit) {
        return results;
      }
    }
  }
  return results;
}

let cachedProvider: SearchProvider | null = null;

/**
 * Resolve the active provider from WEB_SEARCH_PROVIDER. "llm" selects the Anthropic-mirror
 * web_search tool; anything else (default) uses the Bing SERP scrape. Falls back to Bing if "llm"
 * is selected without its base URL + key — but warns loudly so a misconfigured opt-in is visible
 * instead of silently scraping Bing.
 */
export function getSearchProvider(): SearchProvider {
  if (cachedProvider) {
    return cachedProvider;
  }
  const config = getWebConfig();
  if (config.searchProvider === "llm") {
    const missing: string[] = [];
    if (!config.llmSearchApiKey) {
      missing.push("API key (WEB_SEARCH_LLM_API_KEY / OPENAI_API_KEY)");
    }
    if (!config.llmSearchBaseUrl) {
      missing.push("base URL (WEB_SEARCH_LLM_BASE_URL / OPENAI_BASE_URL)");
    }
    if (!config.llmSearchModel) {
      missing.push("model (WEB_SEARCH_LLM_MODEL / OPENAI_MODEL_ID)");
    }
    if (missing.length === 0) {
      cachedProvider = new LlmSearchProvider();
      return cachedProvider;
    }
    console.warn(
      `[web] WEB_SEARCH_PROVIDER=llm but ${missing.join(" and ")} not set; ` +
        "falling back to Bing SERP scrape.",
    );
  }
  cachedProvider = new BingSearchProvider();
  return cachedProvider;
}
