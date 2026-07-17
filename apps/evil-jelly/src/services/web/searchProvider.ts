/** Server-side web search through an Anthropic-compatible Messages endpoint (INV-0009 §3.1). */

import { fetchJson, HttpError } from "./httpClient";
import { getWebConfig } from "./webConfig";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchProviderResponse>;
}

export interface SearchProviderResponse {
  provider: string;
  requestedUrl: string;
  finalUrl: string;
  results: SearchResult[];
}

export interface ParsedSearchQuery {
  terms: string;
  siteConstraint: string | null;
}

/** Separate a site: operator from terms because Anthropic-compatible mirrors may ignore it. */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const match = query.match(/\bsite:([^\s)]+)/i);
  const rawSite = match?.[1]
    ?.replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
  const siteConstraint = rawSite
    ? rawSite
        .replace(/^\*\./, "")
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
    : null;
  const terms = query
    .replace(/\bsite:[^\s)]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    terms: terms || siteConstraint || query.trim(),
    siteConstraint,
  };
}

export function filterSearchResultsBySite(
  results: SearchResult[],
  siteConstraint: string | null,
): SearchResult[] {
  if (!siteConstraint) {
    return results;
  }
  return results.filter((result) => {
    try {
      const host = new URL(result.url).hostname.toLowerCase();
      return host === siteConstraint || host.endsWith(`.${siteConstraint}`);
    } catch {
      return false;
    }
  });
}

/**
 * LLM-API search provider: call a CC-compatible model's Anthropic-mirror endpoint with Anthropic's
 * server-side `web_search` tool and harvest the result blocks. The per-result body is opaque
 * `encrypted_content`, so snippet is left empty (read_webpage fetches the real text). `site:` may
 * not be honored by every mirror, so prefer plain keywords plus post-hoc host filtering.
 */
export class LlmSearchProvider implements SearchProvider {
  readonly name = "llm";

  async search(query: string): Promise<SearchProviderResponse> {
    const config = getWebConfig();
    const parsedQuery = parseSearchQuery(query);
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
              "Do not answer from memory." +
              (parsedQuery.siteConstraint
                ? ` Only return sources hosted on ${parsedQuery.siteConstraint} or its subdomains.`
                : "") +
              `\n\nQuery: ${parsedQuery.terms}`,
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
      results: parseAnthropicWebSearch(json),
    };
  }
}

/** Harvest `web_search_result` items from an Anthropic Messages response into SearchResult[]. */
export function parseAnthropicWebSearch(
  json: unknown,
  limit = Number.POSITIVE_INFINITY,
): SearchResult[] {
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
      if (r.type !== "web_search_result" || typeof r.url !== "string") {
        continue;
      }
      const dedupeKey = normalizeResultUrl(r.url);
      if (!dedupeKey || seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      // Per-result body is Anthropic's opaque encrypted_content → no plain snippet to surface.
      results.push({
        title: typeof r.title === "string" ? r.title : r.url,
        url: r.url,
        snippet: "",
      });
    }
  }
  return results.slice(0, limit);
}

function normalizeResultUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const provider = new LlmSearchProvider();

/** Return the sole supported search provider. Missing configuration fails in search(). */
export function getSearchProvider(): SearchProvider {
  return provider;
}
