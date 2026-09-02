/** Server-side web search through Responses or Anthropic-compatible APIs (INV-0009 §3.1). */

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
  summary: string;
  results: SearchResult[];
}

export interface ParsedResponsesWebSearch {
  summary: string;
  results: SearchResult[];
}

export interface ParsedSearchQuery {
  terms: string;
  siteConstraint: string | null;
}

/** Separate a site: operator for native Responses filters and post-hoc compatibility filtering. */
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
 * LLM-API search provider. Responses is the default because it returns a grounded text summary,
 * URL citations, and (when supported) the complete source list. The former Anthropic Messages
 * search remains available for compatible mirrors via WEB_SEARCH_LLM_PROTOCOL=anthropic.
 */
export class LlmSearchProvider implements SearchProvider {
  readonly name = "llm";
  /** Endpoints that rejected OpenAI's optional complete-sources response expansion. */
  private readonly responsesSourcesUnsupported = new Set<string>();

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

    if (config.llmSearchProtocol === "responses") {
      return this.searchResponses(parsedQuery);
    }
    if (config.llmSearchProtocol === "anthropic") {
      return this.searchAnthropic(parsedQuery);
    }
    throw new HttpError(
      `unsupported WEB_SEARCH_LLM_PROTOCOL ${JSON.stringify(config.llmSearchProtocol)} ` +
        '(expected "responses" or "anthropic")',
    );
  }

  private async searchResponses(parsedQuery: ParsedSearchQuery): Promise<SearchProviderResponse> {
    const config = getWebConfig();
    const url = appendEndpoint(config.llmSearchBaseUrl, "/responses");
    const webSearchTool: Record<string, unknown> = {
      type: "web_search",
      search_context_size: "low",
    };
    if (parsedQuery.siteConstraint) {
      webSearchTool.filters = { allowed_domains: [parsedQuery.siteConstraint] };
    }
    const requestOptions = {
      headers: { Authorization: `Bearer ${config.llmSearchApiKey}` },
      body: {
        model: config.llmSearchModel,
        input:
          "Search the web for the query below. Return a concise evidence summary with citations. " +
          "Do not answer from memory." +
          (parsedQuery.siteConstraint
            ? ` Only use sources hosted on ${parsedQuery.siteConstraint} or its subdomains.`
            : "") +
          `\n\nQuery: ${parsedQuery.terms}`,
        tools: [webSearchTool],
        tool_choice: "required",
        max_output_tokens: 1024,
      },
      timeoutMs: 60_000,
      proxyUrl: config.llmSearchProxyUrl,
    };
    const shouldIncludeSources = !this.responsesSourcesUnsupported.has(url);
    let json: unknown;
    try {
      ({ json } = await fetchJson(url, {
        ...requestOptions,
        body: shouldIncludeSources
          ? { ...requestOptions.body, include: ["web_search_call.action.sources"] }
          : requestOptions.body,
      }));
    } catch (error) {
      if (!shouldIncludeSources || !isUnsupportedSourcesIncludeError(error)) {
        throw error;
      }
      this.responsesSourcesUnsupported.add(url);
      ({ json } = await fetchJson(url, requestOptions));
    }
    const parsed = parseResponsesWebSearch(json);
    return {
      provider: `${this.name}:responses`,
      requestedUrl: url,
      finalUrl: url,
      summary: parsed.summary,
      results: parsed.results,
    };
  }

  private async searchAnthropic(parsedQuery: ParsedSearchQuery): Promise<SearchProviderResponse> {
    const config = getWebConfig();
    const url = appendEndpoint(config.llmSearchBaseUrl, "/v1/messages");
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
      proxyUrl: config.llmSearchProxyUrl,
    });
    return {
      provider: `${this.name}:anthropic`,
      requestedUrl: url,
      finalUrl: url,
      summary: "",
      results: parseAnthropicWebSearch(json),
    };
  }
}

/** Match only validation errors for the optional complete-sources expansion, never broad 400s. */
function isUnsupportedSourcesIncludeError(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 400 || error.responseBody === undefined) {
    return false;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(error.responseBody);
  } catch {
    return false;
  }
  if (
    /invalid_prompt|invalid_value/i.test(serialized) &&
    /include/i.test(serialized) &&
    serialized.includes("web_search_call.action.sources")
  ) {
    return true;
  }

  // OpenRouter reports the rejected array position and the allowed enum values, but omits the
  // submitted value. Since this request sends exactly one known include value, that path is enough
  // to identify this capability mismatch without treating unrelated 400 responses as retryable.
  const body = asRecord(error.responseBody);
  const responseError = asRecord(body?.error);
  const metadata = asRecord(body?.metadata);
  if (responseError?.code !== "invalid_prompt" || typeof metadata?.raw !== "string") {
    return false;
  }
  try {
    const issues = JSON.parse(metadata.raw) as unknown;
    return (
      Array.isArray(issues) &&
      issues.some((issue) => {
        const detail = asRecord(issue);
        const path = detail?.path;
        return (
          detail?.code === "invalid_value" &&
          Array.isArray(path) &&
          path[0] === "include" &&
          path[1] === 0
        );
      })
    );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Harvest the grounded summary, cited URLs, and complete source list from a Responses result. */
export function parseResponsesWebSearch(
  json: unknown,
  limit = Number.POSITIVE_INFINITY,
): ParsedResponsesWebSearch {
  const output = (json as { output?: unknown })?.output;
  if (!Array.isArray(output)) {
    return { summary: "", results: [] };
  }

  const summaries: string[] = [];
  const results: SearchResult[] = [];
  const indexes = new Map<string, number>();

  for (const item of output) {
    const outputItem = item as { type?: unknown; content?: unknown; action?: unknown };
    if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
      for (const part of outputItem.content) {
        const textPart = part as { type?: unknown; text?: unknown; annotations?: unknown };
        if (textPart.type !== "output_text") {
          continue;
        }
        if (typeof textPart.text === "string" && textPart.text.trim()) {
          summaries.push(textPart.text.trim());
        }
        if (!Array.isArray(textPart.annotations)) {
          continue;
        }
        for (const annotation of textPart.annotations) {
          const outer = annotation as { type?: unknown; url_citation?: unknown };
          if (outer.type !== "url_citation") {
            continue;
          }
          const citation = (outer.url_citation ?? outer) as {
            url?: unknown;
            title?: unknown;
            content?: unknown;
          };
          addSearchResult(results, indexes, citation);
        }
      }
      continue;
    }

    if (outputItem.type === "web_search_call") {
      const sources = (outputItem.action as { sources?: unknown } | undefined)?.sources;
      if (!Array.isArray(sources)) {
        continue;
      }
      for (const source of sources) {
        addSearchResult(
          results,
          indexes,
          source as { url?: unknown; title?: unknown; content?: unknown },
        );
      }
    }
  }

  return {
    summary: summaries.join("\n\n"),
    results: results.slice(0, limit),
  };
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

function addSearchResult(
  results: SearchResult[],
  indexes: Map<string, number>,
  source: { url?: unknown; title?: unknown; content?: unknown },
): void {
  if (typeof source.url !== "string") {
    return;
  }
  const dedupeKey = normalizeResultUrl(source.url);
  if (!dedupeKey) {
    return;
  }
  const title = typeof source.title === "string" && source.title.trim() ? source.title : source.url;
  const snippet = typeof source.content === "string" ? source.content.trim() : "";
  const existingIndex = indexes.get(dedupeKey);
  if (existingIndex !== undefined) {
    const existing = results[existingIndex];
    if (!existing) {
      return;
    }
    if (existing.title === existing.url && title !== source.url) {
      existing.title = title;
    }
    if (!existing.snippet && snippet) {
      existing.snippet = snippet;
    }
    return;
  }
  indexes.set(dedupeKey, results.length);
  results.push({ title, url: source.url, snippet });
}

function appendEndpoint(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith(endpoint) ? base : `${base}${endpoint}`;
}

const provider = new LlmSearchProvider();

/** Return the sole supported search provider. Missing configuration fails in search(). */
export function getSearchProvider(): SearchProvider {
  return provider;
}
