/**
 * read_webpage tool: fetch a URL and return sanitized article markdown (INV-0009 §3.2).
 * Static fetch only (no JS rendering); boilerplate (script/style/nav) is stripped before return.
 * Output is charged against the web-research intake budget like other read tools.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { utf8Prefix } from "../../shared/foundation/string";
import { HttpError, readWebpage } from "./index";
import { MAX_WEBPAGE_OUTPUT_BYTES, renderWebpageOutput } from "./webpageOutput";

const readWebpageParameters = z.object({
  url: z.string().min(1).max(2000).describe("Absolute http(s) URL to fetch and read."),
});

export const ReadWebpageTool: ToolDefinition<typeof readWebpageParameters> = {
  name: "read_webpage",
  description:
    "Fetch a single web page and return its main content as clean markdown (scripts, styles, nav, " +
    "and ads removed). Use on URLs from web_search to read the real content. Static fetch only — " +
    "pages that render entirely via client-side JS may return little text. Returns at most 32 KiB; " +
    "long pages are saved as complete cleaned Markdown in an application-owned system-temp directory. " +
    "Use the returned absolute path with grep (directory may be a file) and ranged read_file. " +
    "source-fetch truncation is reported separately.",
  parameters: readWebpageParameters,
  handler: async ({ url }) => {
    try {
      return await renderWebpageOutput(await readWebpage(url));
    } catch (e: unknown) {
      const msg = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
      return `read_webpage failed: ${utf8Prefix(msg, MAX_WEBPAGE_OUTPUT_BYTES - 64)}`;
    }
  },
};
