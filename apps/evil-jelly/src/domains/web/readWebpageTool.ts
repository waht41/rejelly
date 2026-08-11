/**
 * read_webpage tool: fetch a URL and return sanitized article markdown (INV-0009 §3.2).
 * Static fetch only (no JS rendering); boilerplate (script/style/nav) is stripped before return.
 * Output is charged against the web-research intake budget like other read tools.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { HttpError, readWebpage } from "./index";

const readWebpageParameters = z.object({
  url: z.string().min(1).max(2000).describe("Absolute http(s) URL to fetch and read."),
});

export const ReadWebpageTool: ToolDefinition<typeof readWebpageParameters> = {
  name: "read_webpage",
  description:
    "Fetch a single web page and return its main content as clean markdown (scripts, styles, nav, " +
    "and ads removed). Use on URLs from web_search to read the real content. Static fetch only — " +
    "pages that render entirely via client-side JS may return little text.",
  parameters: readWebpageParameters,
  handler: async ({ url }) => {
    try {
      const page = await readWebpage(url);
      if (page.markdown.trim().length === 0) {
        return (
          `read_webpage got an empty body for ${page.url} ` +
          "(likely JS-rendered or blocked). Try another source."
        );
      }
      const header = `# ${page.title || page.url}\nSource: ${page.url}${page.truncated ? " (content truncated)" : ""}\n\n`;
      return header + page.markdown;
    } catch (e: unknown) {
      const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
      return `read_webpage failed: ${msg}`;
    }
  },
};
