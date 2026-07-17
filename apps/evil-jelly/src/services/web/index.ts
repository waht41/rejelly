/**
 * Web research service facade: the two composable primitives the tools wrap (INV-0009 §3).
 * Domain-only, no agent/tool concerns — search returns structured hits; read returns clean markdown.
 */

import { fetchText, HttpError } from "./httpClient";
import { htmlToMarkdown } from "./sanitize";
import { getSearchProvider, type SearchResult } from "./searchProvider";
import { getWebConfig } from "./webConfig";

export type { SearchResult } from "./searchProvider";

export interface WebSearchDiagnostics {
  provider: string;
  requestedHost: string;
  finalHost: string;
  webProxyEnabled: boolean;
  resultCount: number;
  topHosts: string[];
  queryTokenCount: number;
  matchedResultCount: number;
  siteConstraint: string | null;
  siteConstraintMatched: boolean | null;
  polluted: boolean;
  pollutionReasons: string[];
}

export interface WebSearchResult {
  results: SearchResult[];
  diagnostics: WebSearchDiagnostics;
}

export async function webSearch(query: string, limit = 6): Promise<WebSearchResult> {
  const provider = getSearchProvider();
  const trimmed = query.trim();
  const response = await provider.search(trimmed, Math.max(1, Math.min(limit, 15)));
  const diagnostics = diagnoseSearchResults({
    query: trimmed,
    provider: response.provider,
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    results: response.results,
  });
  return {
    results: diagnostics.polluted ? [] : response.results,
    diagnostics,
  };
}

export function diagnoseSearchResults(args: {
  query: string;
  provider: string;
  requestedUrl: string;
  finalUrl: string;
  results: SearchResult[];
}): WebSearchDiagnostics {
  const config = getWebConfig();
  const requestedHost = safeHost(args.requestedUrl);
  const finalHost = safeHost(args.finalUrl);
  const topHosts = unique(args.results.slice(0, 5).map((result) => safeHost(result.url))).filter(
    Boolean,
  );
  const queryTokens = getQueryTokens(args.query);
  const matchedResultCount = args.results.filter((result) =>
    resultMatchesQueryTokens(result, queryTokens),
  ).length;
  const siteConstraint = extractSiteConstraint(args.query);
  const siteConstraintMatched =
    siteConstraint === null
      ? null
      : args.results.some((result) =>
          hostMatchesSiteConstraint(safeHost(result.url), siteConstraint),
        );

  const pollutionReasons: string[] = [];
  if (args.results.length >= 3 && queryTokens.length > 0 && matchedResultCount === 0) {
    pollutionReasons.push("no_query_token_overlap");
  }
  if (siteConstraint !== null && !siteConstraintMatched && args.results.length > 0) {
    pollutionReasons.push("site_constraint_ignored");
  }

  return {
    provider: args.provider,
    requestedHost,
    finalHost,
    webProxyEnabled: config.proxyUrl !== null,
    resultCount: args.results.length,
    topHosts,
    queryTokenCount: queryTokens.length,
    matchedResultCount,
    siteConstraint,
    siteConstraintMatched,
    polluted: pollutionReasons.length > 0,
    pollutionReasons,
  };
}

function getQueryTokens(query: string): string[] {
  const withoutOperators = query.replace(/\bsite:[^\s]+/gi, " ");
  const rawTokens = withoutOperators.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  const stopwords = new Set(["and", "or", "the", "a", "an", "of", "to", "in", "for", "with"]);
  return unique(rawTokens.filter((token) => token.length >= 2 && !stopwords.has(token)));
}

function resultMatchesQueryTokens(result: SearchResult, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) {
    return true;
  }
  const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  return queryTokens.some((token) => haystack.includes(token));
}

function extractSiteConstraint(query: string): string | null {
  const match = query.match(/\bsite:([^\s)]+)/i);
  const raw = match?.[1]
    ?.replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return null;
  }
  return raw
    .replace(/^\*\./, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function hostMatchesSiteConstraint(host: string, siteConstraint: string): boolean {
  return host === siteConstraint || host.endsWith(`.${siteConstraint}`);
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
