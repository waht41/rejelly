/**
 * web_search tool: thin wrapper over the configured server-side search protocol (INV-0009 §3.1).
 * Responses providers can return a grounded summary plus sources; pair with read_webpage when the
 * underlying page text is needed for verification or detail.
 */

import { equipTraceAttr, type ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { HttpError, type WebSearchDiagnostics, webSearch } from "./index";

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
      const { summary, results, diagnostics } = await webSearch(query, limit ?? 6);
      equipWebSearchTraceAttrs(diagnostics);
      if (!summary && results.length === 0) {
        return `No web results for ${JSON.stringify(query)}. Try different or broader keywords.`;
      }
      const lines = results.map((r, i) =>
        [`${i + 1}. ${r.title}`, `   ${r.url}`, r.snippet ? `   ${r.snippet}` : ""]
          .filter(Boolean)
          .join("\n"),
      );
      return [
        `Web results for ${JSON.stringify(query)}:`,
        summary ? `Search summary:\n${summary}` : "",
        lines.length > 0 ? `Sources:\n${lines.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
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
        "evil_jelly.web_search.raw_result_count": diagnostics.rawResultCount,
        "evil_jelly.web_search.result_count": diagnostics.resultCount,
        "evil_jelly.web_search.top_hosts": diagnostics.topHosts.join(","),
        "evil_jelly.web_search.site_constraint": diagnostics.siteConstraint ?? "",
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
