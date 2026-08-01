/**
 * Local filesystem tools with bounded directory exploration and bounded batch reads.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { fileLocatorAttributes, fileLocatorFromResolved } from "../shared/fs-policy/file-locator";
import {
  AGENT_SCRATCH_DIR,
  getWorkspaceFsPolicy,
  type ResolvedFsPath,
  type WorkspaceDirEntry,
  type WorkspaceFsPolicy,
} from "../shared/fs-policy/workspace-fs-policy";
import { type PseudoXmlAttributes, renderPseudoXmlElement } from "../shared/lib/pseudoXml";
import { resolveToolFsPath } from "./outsideAccess";

/** Hard guards to keep tool output compact and predictable. */
export const MAX_READ_BYTES_PER_CALL = 100 * 1024;
/** Ranged reads load the whole file to slice lines; refuse sources beyond this. */
export const MAX_RANGED_READ_SOURCE_BYTES = 10 * 1024 * 1024;
/** Refuse minified bundles and pathological logs before one line can dominate context. */
export const MAX_READ_LINE_BYTES = 32 * 1024;
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

function renderReadFileResult(
  displayPath: string,
  content: string,
  attributes?: PseudoXmlAttributes,
): string {
  return renderPseudoXmlElement("file", content, {
    path: displayPath,
    ...attributes,
  });
}

function renderReadFileError(displayPath: string, error: string): string {
  return renderReadFileResult(displayPath, error, { status: "error" });
}

function renderResolvedReadFileResult(
  resolved: ResolvedFsPath,
  content: string,
  attributes?: PseudoXmlAttributes,
): string {
  const locator = fileLocatorFromResolved(resolved);
  return renderReadFileResult(locator.path, content, {
    ...fileLocatorAttributes(locator),
    ...attributes,
  });
}

function renderResolvedReadFileError(
  resolved: ResolvedFsPath,
  error: string,
  attributes?: PseudoXmlAttributes,
): string {
  return renderResolvedReadFileResult(resolved, error, { status: "error", ...attributes });
}

function findOversizedLine(
  lines: readonly string[],
  startLine = 1,
): { line: number; bytes: number } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const bytes = Buffer.byteLength(lines[index] ?? "", "utf8");
    if (bytes > MAX_READ_LINE_BYTES) {
      return { line: startLine + index, bytes };
    }
  }
  return undefined;
}

function oversizedLineError(hit: { line: number; bytes: number }): string {
  return (
    `Error: Line ${hit.line} is ${hit.bytes} bytes, above the ` +
    `${MAX_READ_LINE_BYTES / 1024} KB single-line limit. ` +
    "This is likely generated/minified output or a pathological log line. " +
    "Use a narrower search or another targeted inspection method instead of loading the line into context."
  );
}

function oversizedLineAttributes(
  statSize: number,
  totalLines: number,
  hit: { line: number; bytes: number },
): PseudoXmlAttributes {
  return {
    reason: "oversized-line",
    "size-bytes": String(statSize),
    "total-lines": String(totalLines),
    "offending-line": String(hit.line),
    "line-bytes": String(hit.bytes),
    "max-line-bytes": String(MAX_READ_LINE_BYTES),
  };
}

export const ReadFileTool: ToolDefinition<typeof readFileParameters> = {
  name: "read_file",
  description:
    `Read one or more files with a strict combined ${MAX_READ_BYTES_PER_CALL / 1024} KB size limit. ` +
    `Lines above ${MAX_READ_LINE_BYTES / 1024} KB are refused to keep minified bundles and pathological logs out of context. ` +
    "Returns one XML-like <file> envelope per result while leaving each file body unchanged. " +
    'An unchanged result may be returned as <file ... status="unchanged" reference="previous-read" /> when the identical prior result is still in context. ' +
    "Pass { path, offset, limit } entries to read a line range from files too large to read whole, or around a known line; range metadata is in the envelope attributes and is not added to the body. " +
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
        results.push(renderReadFileError(filePath, `Error: ${resolved.error}`));
        continue;
      }

      try {
        const stat = await policy.statResolved(resolved);
        if (!hasRange) {
          if (totalBytes + stat.size > MAX_READ_BYTES_PER_CALL) {
            results.push(
              renderResolvedReadFileError(
                resolved,
                `Error: Combined file sizes exceed the ${MAX_READ_BYTES_PER_CALL / 1024} KB limit for this tool call. ` +
                  "Read fewer files or narrow the request with a line range, search, or structural inspection.",
                {
                  reason: "combined-size-limit",
                  "size-bytes": String(stat.size),
                  "remaining-call-bytes": String(MAX_READ_BYTES_PER_CALL - totalBytes),
                  "max-call-bytes": String(MAX_READ_BYTES_PER_CALL),
                },
              ),
            );
            continue;
          }

          totalBytes += stat.size;
          const content = await policy.readResolved(resolved);
          const lines = content.split(/\r?\n/);
          const oversizedLine = findOversizedLine(lines);
          if (oversizedLine) {
            totalBytes -= stat.size;
            results.push(
              renderResolvedReadFileError(
                resolved,
                oversizedLineError(oversizedLine),
                oversizedLineAttributes(stat.size, lines.length, oversizedLine),
              ),
            );
            continue;
          }
          results.push(renderResolvedReadFileResult(resolved, content));
          continue;
        }

        if (stat.size > MAX_RANGED_READ_SOURCE_BYTES) {
          results.push(
            renderResolvedReadFileError(
              resolved,
              `Error: File is ${Math.ceil(stat.size / 1024)} KB, above the ` +
                `${MAX_RANGED_READ_SOURCE_BYTES / 1024 / 1024} MB cap for ranged reads. ` +
                "Use a narrower search or another targeted inspection method instead.",
              {
                reason: "ranged-source-limit",
                "size-bytes": String(stat.size),
                "max-source-bytes": String(MAX_RANGED_READ_SOURCE_BYTES),
              },
            ),
          );
          continue;
        }

        const content = await policy.readResolved(resolved);
        const lines = content.split(/\r?\n/);
        const startLine = offset ?? 1;
        if (startLine > lines.length) {
          results.push(
            renderResolvedReadFileError(
              resolved,
              `Error: offset ${startLine} is past the end of the file (${lines.length} lines).`,
            ),
          );
          continue;
        }

        const endLine =
          limit === undefined ? lines.length : Math.min(lines.length, startLine + limit - 1);
        const selectedLines = lines.slice(startLine - 1, endLine);
        const oversizedLine = findOversizedLine(selectedLines, startLine);
        if (oversizedLine) {
          results.push(
            renderResolvedReadFileError(
              resolved,
              oversizedLineError(oversizedLine),
              oversizedLineAttributes(stat.size, lines.length, oversizedLine),
            ),
          );
          continue;
        }
        const snippet = selectedLines.join("\n");
        const snippetBytes = Buffer.byteLength(snippet, "utf8");
        if (totalBytes + snippetBytes > MAX_READ_BYTES_PER_CALL) {
          results.push(
            renderResolvedReadFileError(
              resolved,
              `Error: Requested line range exceeds the combined ${MAX_READ_BYTES_PER_CALL / 1024} KB limit for this tool call. ` +
                "Request a smaller limit or split the request into multiple calls.",
              {
                reason: "combined-size-limit",
                "size-bytes": String(stat.size),
                "range-bytes": String(snippetBytes),
                "remaining-call-bytes": String(MAX_READ_BYTES_PER_CALL - totalBytes),
                "max-call-bytes": String(MAX_READ_BYTES_PER_CALL),
                "start-line": String(startLine),
                "end-line": String(endLine),
                "total-lines": String(lines.length),
              },
            ),
          );
          continue;
        }

        totalBytes += snippetBytes;
        results.push(
          renderResolvedReadFileResult(resolved, snippet, {
            "start-line": String(startLine),
            "end-line": String(endLine),
            "total-lines": String(lines.length),
          }),
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push(renderResolvedReadFileError(resolved, `Error: Failed to read file: ${msg}`));
      }
    }

    return results.join("\n");
  },
};
