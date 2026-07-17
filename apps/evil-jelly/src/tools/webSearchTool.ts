/**
 * web_search tool: thin wrapper over the Anthropic-compatible server-side search (INV-0009 §3.1).
 * Returns a compact, model-friendly list of {title, url, snippet}; pair with read_webpage to pull
 * actual page text before drawing conclusions (snippets alone invite fabrication).
 */

import { equipTraceAttr, type ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { HttpError, type WebSearchDiagnostics, webSearch } from "../services/web";

const webSearchParameters = z.object({
  query: z.string().min(1).max(400).describe("Search query (natural language or keywords)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe("Maximum number of results to return (default 6)."),
});

export const WebSearchTool: ToolDefinition<typeof webSearchParameters> = {
  name: "web_search",
  description:
    "Search the web and return ranked results as a numbered list of title / URL / snippet. " +
    "Use to discover sources for a question. Snippets are previews only — call read_webpage on the " +
    "promising URLs to read the actual content before concluding. Never invent URLs.",
  parameters: webSearchParameters,
  handler: async ({ query, limit }) => {
    try {
      const { results, diagnostics } = await webSearch(query, limit ?? 6);
      equipWebSearchTraceAttrs(diagnostics);
      if (diagnostics.polluted) {
        const reasons = diagnostics.pollutionReasons.join(", ");
        const hostText =
          diagnostics.finalHost && diagnostics.finalHost !== diagnostics.requestedHost
            ? `${diagnostics.requestedHost} -> ${diagnostics.finalHost}`
            : diagnostics.finalHost || diagnostics.requestedHost || "unknown";
        return (
          `Web results for ${JSON.stringify(query)} looked polluted/degraded and were withheld. ` +
          `Provider=${diagnostics.provider}, host=${hostText}, reasons=${reasons}. ` +
          "Try a different provider, more specific source URLs, or different keywords."
        );
      }
      if (results.length === 0) {
        return `No web results for ${JSON.stringify(query)}. Try different or broader keywords.`;
      }
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || "(no snippet)"}`,
      );
      return `Web results for ${JSON.stringify(query)}:\n${lines.join("\n")}`;
    } catch (e: unknown) {
      const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
      return `web_search failed: ${msg}`;
    }
  },
};

function equipWebSearchTraceAttrs(diagnostics: WebSearchDiagnostics): void {
  try {
    equipTraceAttr(
      {
        "evil_jelly.web_search.provider": diagnostics.provider,
        "evil_jelly.web_search.requested_host": diagnostics.requestedHost,
        "evil_jelly.web_search.final_host": diagnostics.finalHost,
        "evil_jelly.web_search.proxy_enabled": diagnostics.webProxyEnabled,
        "evil_jelly.web_search.result_count": diagnostics.resultCount,
        "evil_jelly.web_search.top_hosts": diagnostics.topHosts.join(","),
        "evil_jelly.web_search.query_token_count": diagnostics.queryTokenCount,
        "evil_jelly.web_search.matched_result_count": diagnostics.matchedResultCount,
        "evil_jelly.web_search.site_constraint": diagnostics.siteConstraint ?? "",
        "evil_jelly.web_search.site_constraint_matched": diagnostics.siteConstraintMatched ?? false,
        "evil_jelly.web_search.polluted": diagnostics.polluted,
        "evil_jelly.web_search.pollution_reasons": diagnostics.pollutionReasons.join(","),
      },
      { target: "local" },
    );
  } catch (error) {
    if ((error as { name?: unknown }).name === "ContextNotFoundError") {
      return;
    }
    throw error;
  }
}
