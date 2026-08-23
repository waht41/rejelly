/**
 * Tool wrapper around FuzzySearchService for LLM use.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { fuzzySearchFiles } from "./FuzzySearchService";

const fuzzySearchPathsParameters = z.object({
  keyword: z
    .string()
    .min(1)
    .describe(
      "Substring / fuzzy needle for file paths (non-contiguous character matches allowed).",
    ),
  directory: z
    .string()
    .default(".")
    .describe(
      'Directory under workspace to scan (relative to workspace root). Use "." for the whole repo.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of paths to return (default 20)."),
  includeIgnored: z
    .boolean()
    .default(false)
    .describe(
      "Include ignored files within the explicit directory. Workspace root is refused; node_modules must be scoped to a concrete package.",
    ),
});

export const FuzzySearchTool: ToolDefinition<typeof fuzzySearchPathsParameters> = {
  name: "fuzzy_search_paths",
  description:
    "Fast fuzzy search over file paths under a directory: respects .gitignore (via ripgrep, then git, " +
    "then a bounded Node walk), ranks matches, and returns only the best-scoring paths. " +
    "Set includeIgnored only for one explicit subdirectory; dependency searches require a concrete package path. " +
    "Use when list_directory is too shallow or you need approximate path matching (e.g. typos, shortened names).",
  parameters: fuzzySearchPathsParameters,
  handler: async ({ keyword, directory, limit, includeIgnored }) => {
    try {
      const matches = await fuzzySearchFiles(keyword, directory, limit, {
        cachePolicy: "refresh",
        includeIgnored,
      });

      if (matches.length === 0) {
        return (
          `No file paths matched ${JSON.stringify(keyword)} under ${JSON.stringify(directory)} ` +
          `${includeIgnored ? "(bounded ignored-subtree scan)" : "(after .gitignore rules)"}. ` +
          "Try a shorter needle or a different directory."
        );
      }
      const lines = matches.map((m, i) => `${i + 1}. ${m.path}`);
      return `Fuzzy path matches under workspace-relative ${JSON.stringify(directory)}:\n${lines.join("\n")}`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `fuzzy_search_paths failed: ${msg}`;
    }
  },
};
