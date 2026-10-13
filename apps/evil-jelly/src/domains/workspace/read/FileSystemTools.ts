/**
 * Local filesystem tools with bounded directory exploration and bounded batch reads.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import {
  fileLocatorAttributes,
  fileLocatorFromResolved,
} from "../../../shared/fs-policy/file-locator";
import { AGENT_SCRATCH_DIR } from "../../../shared/fs-policy/workspace-context";
import {
  getWorkspaceFiles,
  type ResolvedFsPath,
  type WorkspaceFiles,
} from "../../../shared/fs-policy/workspace-files";
import {
  type PseudoXmlAttributes,
  renderPseudoXmlElement,
} from "../../../shared/model/prompt/pseudoXml";
import { resolveFileToolPath } from "../file-access/resolveFileToolPath";

/** Hard guards to keep tool output compact and predictable. */
export const MAX_READ_BYTES_PER_CALL = 100 * 1024;
/** Ranged reads load the whole file to slice lines; refuse sources beyond this. */
export const MAX_RANGED_READ_SOURCE_BYTES = 10 * 1024 * 1024;
/** Refuse minified bundles and pathological logs before one line can dominate context. */
export const MAX_READ_LINE_BYTES = 32 * 1024;
const MAX_NON_TEXT_CHARACTER_RATIO = 0.05;
const MIN_NON_TEXT_CHARACTERS = 4;
export const MAX_DIR_DEPTH = 3;
export const MAX_DIRECTORY_OUTPUT_CHARS = 15_000;
export const MAX_DIRECTORY_SCAN_ENTRIES = 10_000;
export const MAX_IGNORED_DIRECTORY_SCAN_ENTRIES = 2_000;

async function getDirectoryTree(
  policy: WorkspaceFiles,
  dir: ResolvedFsPath,
  maxDepth: number,
  includeIgnored: boolean,
  state: { visitedEntries: number; maxEntries: number },
): Promise<string[]> {
  const results: string[] = [];
  const queue = [{ dir, depth: 1, relativePath: "" }];
  for (let index = 0; index < queue.length && state.visitedEntries < state.maxEntries; index++) {
    const current = queue[index];
    if (current.depth > maxDepth) {
      continue;
    }
    try {
      for await (const entry of policy.iterateDirectoryResolved(current.dir)) {
        state.visitedEntries += 1;
        if (
          !(includeIgnored
            ? policy.shouldSkipScopedResolvedEntry(current.dir, entry, true)
            : policy.shouldSkipResolvedEntry(current.dir, entry))
        ) {
          const prefix = "  ".repeat(current.depth - 1);
          const relativePath = current.relativePath
            ? `${current.relativePath}/${entry.name}`
            : entry.name;
          if (entry.isSymbolicLink?.()) {
            results.push(`${prefix}[link] ${relativePath}`);
          } else if (entry.isDirectory()) {
            results.push(`${prefix}[dir]  ${relativePath}/`);
            if (current.depth < maxDepth) {
              queue.push({
                dir: policy.childResolved(current.dir, entry.name),
                depth: current.depth + 1,
                relativePath,
              });
            }
          } else {
            results.push(`${prefix}[file] ${relativePath}`);
          }
        }
        if (state.visitedEntries >= state.maxEntries) {
          break;
        }
      }
    } catch {
      // Skip unreadable directories without dropping queued siblings or collected entries.
    }
  }
  return results;
}

const listDirParameters = z.object({
  dirPath: z.string().default(".").describe('Directory path, or "." for the workspace root.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DIR_DEPTH)
    .default(1)
    .describe(`How many directory levels to list. Max ${MAX_DIR_DEPTH}.`),
  includeIgnored: z
    .boolean()
    .default(false)
    .describe(
      "Include ignored files and dependency directories. Traversal is bounded by the per-call directory-entry limit; no package scope is required.",
    ),
});

export const ListDirTool: ToolDefinition<typeof listDirParameters> = {
  name: "list_directory",
  description:
    "List files and nested subdirectories breadth-first with a bounded depth. Nested entries show paths relative to dirPath. " +
    "Respects workspace root .gitignore and always hides bulky/tool dirs by default. " +
    `Inspects at most ${MAX_DIRECTORY_SCAN_ENTRIES} directory entries normally, or ${MAX_IGNORED_DIRECTORY_SCAN_ENTRIES} with includeIgnored, across the entire call (including skipped entries). ` +
    "Use includeIgnored to explore ignored directories, including node_modules, .pnpm, dist, and build. Link names are shown but never followed. " +
    `${AGENT_SCRATCH_DIR}/ is the agent scratch directory for temporary files. ` +
    "Use depth > 1 to scan layout faster.",
  parameters: listDirParameters,
  handler: async ({ dirPath, depth, includeIgnored }) => {
    const policy = getWorkspaceFiles();
    const resolved = await resolveFileToolPath(dirPath, { kind: "scan", includeIgnored });
    if (!resolved.ok) {
      return resolved.error;
    }
    try {
      const state = {
        visitedEntries: 0,
        maxEntries: includeIgnored
          ? MAX_IGNORED_DIRECTORY_SCAN_ENTRIES
          : MAX_DIRECTORY_SCAN_ENTRIES,
      };
      const treeLines = await getDirectoryTree(policy, resolved, depth, includeIgnored, state);
      const limitNotice =
        state.visitedEntries >= state.maxEntries
          ? `\n... [scan limit reached: ${state.maxEntries} directory entries; results may be incomplete. Narrow dirPath.]`
          : "";
      if (treeLines.length === 0 && !limitNotice) {
        return `Directory ${resolved.abs} is empty or only contains ignored folders.`;
      }

      const output = treeLines.join("\n");
      if (output.length > MAX_DIRECTORY_OUTPUT_CHARS) {
        return (
          `Contents of ${resolved.abs} (depth ${depth}, truncated):\n` +
          `${output.slice(0, MAX_DIRECTORY_OUTPUT_CHARS - limitNotice.length)}\n...${limitNotice}`
        );
      }

      return `Contents of ${resolved.abs} (depth ${depth}):\n${output}${limitNotice}`;
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
        "(e.g. a large file, or context around a search hit). " +
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

interface NonTextContent {
  reason: "nul-byte" | "control-characters" | "replacement-characters";
  count: number;
}

function detectNonTextContent(content: string): NonTextContent | undefined {
  let nulBytes = 0;
  let controlCharacters = 0;
  let replacementCharacters = 0;
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) {
      nulBytes += 1;
    } else if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controlCharacters += 1;
    } else if (code === 0xfffd) {
      replacementCharacters += 1;
    }
  }
  if (nulBytes > 0) {
    return { reason: "nul-byte", count: nulBytes };
  }
  const length = Math.max(1, content.length);
  if (
    controlCharacters >= MIN_NON_TEXT_CHARACTERS &&
    controlCharacters / length > MAX_NON_TEXT_CHARACTER_RATIO
  ) {
    return { reason: "control-characters", count: controlCharacters };
  }
  if (
    replacementCharacters >= MIN_NON_TEXT_CHARACTERS &&
    replacementCharacters / length > MAX_NON_TEXT_CHARACTER_RATIO
  ) {
    return { reason: "replacement-characters", count: replacementCharacters };
  }
  return undefined;
}

function nonTextContentError(
  resolved: ResolvedFsPath,
  sizeBytes: number,
  hit: NonTextContent,
): string {
  return renderResolvedReadFileError(
    resolved,
    "Error: File does not appear to contain normal UTF-8 text. Use an appropriate binary, image, or targeted inspection tool.",
    {
      reason: "binary-content",
      "size-bytes": String(sizeBytes),
      "binary-signal": hit.reason,
      "signal-count": String(hit.count),
    },
  );
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
    const policy = getWorkspaceFiles();
    let totalBytes = 0;
    const results: string[] = [];

    for (const entry of filePaths) {
      const { path: filePath, offset, limit } = typeof entry === "string" ? { path: entry } : entry;
      const hasRange = offset !== undefined || limit !== undefined;
      const resolved = await resolveFileToolPath(filePath, { kind: "read" });
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

          const content = await policy.readResolved(resolved);
          const contentBytes = Buffer.byteLength(content, "utf8");
          if (totalBytes + contentBytes > MAX_READ_BYTES_PER_CALL) {
            results.push(
              renderResolvedReadFileError(
                resolved,
                `Error: Combined file sizes exceed the ${MAX_READ_BYTES_PER_CALL / 1024} KB limit for this tool call. ` +
                  "Read fewer files or narrow the request with a line range, search, or structural inspection.",
                {
                  reason: "combined-size-limit",
                  "size-bytes": String(contentBytes),
                  "remaining-call-bytes": String(MAX_READ_BYTES_PER_CALL - totalBytes),
                  "max-call-bytes": String(MAX_READ_BYTES_PER_CALL),
                },
              ),
            );
            continue;
          }
          const nonText = detectNonTextContent(content);
          if (nonText) {
            results.push(nonTextContentError(resolved, contentBytes, nonText));
            continue;
          }
          const lines = content.split(/\r?\n/);
          const oversizedLine = findOversizedLine(lines);
          if (oversizedLine) {
            results.push(
              renderResolvedReadFileError(
                resolved,
                oversizedLineError(oversizedLine),
                oversizedLineAttributes(contentBytes, lines.length, oversizedLine),
              ),
            );
            continue;
          }
          totalBytes += contentBytes;
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
        const contentBytes = Buffer.byteLength(content, "utf8");
        const nonText = detectNonTextContent(content);
        if (nonText) {
          results.push(nonTextContentError(resolved, contentBytes, nonText));
          continue;
        }
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
