/**
 * Web research service facade: the two composable primitives the tools wrap (INV-0009 §3).
 * Domain-only, no agent/tool concerns — search returns structured hits; read returns clean markdown.
 */

import { fetchText, HttpError } from "./httpClient";
import { htmlToMarkdown } from "./sanitize";
import {
  filterSearchResultsBySite,
  getSearchProvider,
  parseSearchQuery,
  type SearchResult,
} from "./searchProvider";
import { getWebConfig } from "./webConfig";

export type { SearchResult } from "./searchProvider";

export interface WebSearchDiagnostics {
  provider: string;
  requestedHost: string;
  finalHost: string;
  webProxyEnabled: boolean;
  rawResultCount: number;
  resultCount: number;
  topHosts: string[];
  siteConstraint: string | null;
}

export interface WebSearchResult {
  summary: string;
  results: SearchResult[];
  diagnostics: WebSearchDiagnostics;
}

export async function webSearch(query: string, limit = 6): Promise<WebSearchResult> {
  const provider = getSearchProvider();
  const trimmed = query.trim();
  const normalizedLimit = Math.max(1, Math.min(limit, 15));
  const response = await provider.search(trimmed);
  const config = getWebConfig();
  const { siteConstraint } = parseSearchQuery(trimmed);
  const results = filterSearchResultsBySite(response.results, siteConstraint).slice(
    0,
    normalizedLimit,
  );
  const diagnostics: WebSearchDiagnostics = {
    provider: response.provider,
    requestedHost: safeHost(response.requestedUrl),
    finalHost: safeHost(response.finalUrl),
    webProxyEnabled: config.llmSearchProxyUrl !== null,
    rawResultCount: response.results.length,
    resultCount: results.length,
    topHosts: unique(results.slice(0, 5).map((result) => safeHost(result.url))).filter(Boolean),
    siteConstraint,
  };
  return {
    summary: response.summary,
    results,
    diagnostics,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export interface ReadWebpageResult {
  url: string;
  title: string;
  markdown: string;
  truncated: boolean;
}

export async function readWebpage(url: string): Promise<ReadWebpageResult> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new HttpError(`read_webpage expects an absolute http(s) URL, got "${url}"`);
  }
  const { url: finalUrl, body, truncated } = await fetchText(trimmed, { acceptHtmlOnly: true });
  const { title, markdown } = htmlToMarkdown(body);
  return { url: finalUrl, title, markdown, truncated };
}

export { HttpError } from "./httpClient";
