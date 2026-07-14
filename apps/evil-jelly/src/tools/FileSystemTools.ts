/**
 * Local filesystem tools with bounded directory exploration and bounded batch reads.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import {
  AGENT_SCRATCH_DIR,
  getWorkspaceFsPolicy,
  type ResolvedFsPath,
  type WorkspaceDirEntry,
  type WorkspaceFsPolicy,
} from "../shared/fs-policy/workspace-fs-policy";
import { resolveToolFsPath } from "./outsideAccess";

/** Hard guards to keep tool output compact and predictable. */
export const MAX_READ_BYTES_PER_CALL = 100 * 1024;
/** Ranged reads load the whole file to slice lines; refuse sources beyond this. */
export const MAX_RANGED_READ_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_DIR_DEPTH = 3;
export const MAX_DIRECTORY_OUTPUT_CHARS = 15_000;

async function getDirectoryTree(
  policy: WorkspaceFsPolicy,
  dir: ResolvedFsPath,
  currentDepth: number,
  maxDepth: number,
): Promise<string[]> {
  if (currentDepth > maxDepth) {
    return [];
  }

  let results: string[] = [];
  let entries: WorkspaceDirEntry[];
  try {
    entries = await policy.readdirResolved(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (policy.shouldSkipResolvedEntry(dir, entry)) {
      continue;
    }

    const prefix = "  ".repeat(currentDepth - 1);
    if (entry.isDirectory()) {
      results.push(`${prefix}[dir]  ${entry.name}/`);
      const subEntries = await getDirectoryTree(
        policy,
        policy.childResolved(dir, entry.name),
        currentDepth + 1,
        maxDepth,
      );
      results = results.concat(subEntries);
      continue;
    }

    results.push(`${prefix}[file] ${entry.name}`);
  }

  return results;
}

const listDirParameters = z.object({
  dirPath: z
    .string()
    .default(".")
    .describe(
      'Directory path, or "." for workspace root. Workspace-outside paths follow fs access policy.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DIR_DEPTH)
    .default(1)
    .describe(`How many directory levels to list. Max ${MAX_DIR_DEPTH}.`),
});

export const ListDirTool: ToolDefinition<typeof listDirParameters> = {
  name: "list_directory",
  description:
    "List files and nested subdirectories with a bounded depth. " +
    "Respects workspace root .gitignore and always hides bulky/tool dirs (e.g. node_modules, .git, .cursor). " +
    `${AGENT_SCRATCH_DIR}/ is the agent scratch directory for temporary files. ` +
    "Use depth > 1 to scan layout faster.",
  parameters: listDirParameters,
  handler: async ({ dirPath, depth }) => {
    const policy = getWorkspaceFsPolicy();
    const resolved = await resolveToolFsPath(dirPath, "read");
    if (!resolved.ok) {
      return resolved.error;
    }
    try {
      const treeLines = await getDirectoryTree(policy, resolved, 1, depth);
      if (treeLines.length === 0) {
        return `Directory ${resolved.abs} is empty or only contains ignored folders.`;
      }

      const output = treeLines.join("\n");
      if (output.length > MAX_DIRECTORY_OUTPUT_CHARS) {
        return (
          `Contents of ${resolved.abs} (depth ${depth}, truncated):\n` +
          `${output.slice(0, MAX_DIRECTORY_OUTPUT_CHARS)}\n...`
        );
      }

      return `Contents of ${resolved.abs} (depth ${depth}):\n${output}`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Failed to list directory ${dirPath}: ${msg}`;
    }
  },
};

const readFileEntrySchema = z.union([
  z.string(),
  z.object({
    path: z.string().describe("File path to read."),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based line number to start reading from. Defaults to 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum number of lines to read from offset. Defaults to end of file."),
  }),
]);

const readFileParameters = z.object({
  filePaths: z
    .array(readFileEntrySchema)
    .min(1)
    .describe(
      "One or more files to read. Each entry is a path string, or { path, offset, limit } to read a line range " +
        "(e.g. a large file, or context around a grep_search hit). " +
        `Combined file contents are capped at ${MAX_READ_BYTES_PER_CALL / 1024} KB per call.`,
    ),
});

export const ReadFileTool: ToolDefinition<typeof readFileParameters> = {
  name: "read_file",
  description:
    `Read one or more files with a strict combined ${MAX_READ_BYTES_PER_CALL / 1024} KB size limit. ` +
    "Pass { path, offset, limit } entries to read a line range (line-numbered output) from files too large to read whole, or around a known line. " +
    `Use ast_document_symbols first if you only need file structure or declarations. ${AGENT_SCRATCH_DIR}/ is the agent scratch directory for temporary files.`,
  parameters: readFileParameters,
  handler: async ({ filePaths }) => {
    const policy = getWorkspaceFsPolicy();
    let totalBytes = 0;
    const results: string[] = [];

    for (const entry of filePaths) {
      const { path: filePath, offset, limit } = typeof entry === "string" ? { path: entry } : entry;
      const hasRange = offset !== undefined || limit !== undefined;
      const resolved = await resolveToolFsPath(filePath, "read");
      if (!resolved.ok) {
        results.push(`--- FILE: ${filePath} ---\nError: ${resolved.error}\n`);
        continue;
      }

      try {
        const stat = await policy.statResolved(resolved);
        if (!hasRange) {
          if (totalBytes + stat.size > MAX_READ_BYTES_PER_CALL) {
            results.push(
              `--- FILE: ${resolved.displayPath} ---\n` +
                `Error: Combined file sizes exceed the ${MAX_READ_BYTES_PER_CALL / 1024} KB limit for this tool call. ` +
                "Read fewer files, pass { path, offset, limit } to read a line range, " +
                "or use ast_document_symbols / ast_read_symbol_code for JS/TS files.\n",
            );
            continue;
          }

          totalBytes += stat.size;
          const content = await policy.readResolved(resolved);
          results.push(`--- FILE: ${resolved.displayPath} ---\n${content}\n`);
          continue;
        }

        if (stat.size > MAX_RANGED_READ_SOURCE_BYTES) {
          results.push(
            `--- FILE: ${resolved.displayPath} ---\n` +
              `Error: File is ${Math.ceil(stat.size / 1024)} KB, above the ` +
              `${MAX_RANGED_READ_SOURCE_BYTES / 1024 / 1024} MB cap for ranged reads. ` +
              "Use grep_search to locate the relevant lines instead.\n",
          );
          continue;
        }

        const content = await policy.readResolved(resolved);
        const lines = content.split(/\r?\n/);
        const startLine = offset ?? 1;
        if (startLine > lines.length) {
          results.push(
            `--- FILE: ${resolved.displayPath} ---\n` +
              `Error: offset ${startLine} is past the end of the file (${lines.length} lines).\n`,
          );
          continue;
        }

        const endLine =
          limit === undefined ? lines.length : Math.min(lines.length, startLine + limit - 1);
        const snippet = lines
          .slice(startLine - 1, endLine)
          .map((lineText, i) => `${startLine + i}\t${lineText}`)
          .join("\n");
        const snippetBytes = Buffer.byteLength(snippet, "utf8");
        if (totalBytes + snippetBytes > MAX_READ_BYTES_PER_CALL) {
          results.push(
            `--- FILE: ${resolved.displayPath} ---\n` +
              `Error: Requested line range exceeds the combined ${MAX_READ_BYTES_PER_CALL / 1024} KB limit for this tool call. ` +
              "Request a smaller limit or split the request into multiple calls.\n",
          );
          continue;
        }

        totalBytes += snippetBytes;
        results.push(
          `--- FILE: ${resolved.displayPath} (lines ${startLine}-${endLine} of ${lines.length}) ---\n${snippet}\n`,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push(`--- FILE: ${resolved.displayPath} ---\nError: Failed to read file: ${msg}\n`);
      }
    }

    return results.join("\n");
  },
};
