/**
 * Fast codebase search: prefers ripgrep, then git grep, then a bounded Node traversal.
 * Uses execFileSync only (no shell), so arguments are not interpreted by a shell.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ToolDefinition } from "@rejelly/core";
import picomatch from "picomatch";
import { z } from "zod";
import {
  getWorkspaceFiles,
  type ResolvedFsPath,
  type WorkspaceFiles,
} from "../../../shared/fs-policy/workspace-files";
import {
  TOOL_ALWAYS_IGNORED_DIR_NAMES,
  type WorkspaceDirEntry,
} from "../../../shared/fs-policy/workspace-scan";
import { resolveFileToolPath } from "../file-access/resolveFileToolPath";

const MAX_FALLBACK_FILE_BYTES = 200 * 1024;
const MAX_FALLBACK_FILES = 8000;
const MAX_SCOPED_IGNORED_ENTRIES = 50_000;
const TRUNCATE_MAX_LINES = 300;
/** Bound every model-facing grep line, including native backend output and context lines. */
export const MAX_GREP_OUTPUT_LINE_BYTES = 4 * 1024;
/** Bound the full response so many individually valid lines cannot overshoot context. */
export const MAX_GREP_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 12;

const GrepSearchSchema = z.object({
  query: z.string().min(1).describe("Keyword or regex pattern to search for."),
  filePattern: z
    .string()
    .optional()
    .describe(
      "Optional glob for paths, e.g. '*.ts', '*.{ts,tsx}', or 'src/**/*.ts' (rg -g / git pathspec; Node fallback uses picomatch).",
    ),
  contextLines: z
    .number()
    .default(DEFAULT_CONTEXT_LINES)
    .describe(
      `Context lines around each match (default ${DEFAULT_CONTEXT_LINES}, max ${MAX_CONTEXT_LINES}; out-of-range values are clamped).`,
    ),
  directory: z
    .string()
    .default(".")
    .describe("Directory to search. Relative paths resolve from the workspace."),
  includeIgnored: z
    .boolean()
    .default(false)
    .describe(
      "Include ignored files within the explicit directory. Workspace root is refused; node_modules must be scoped to a concrete package.",
    ),
});

function utf8Prefix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  while (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1] ?? "")) {
    low -= 1;
  }
  return value.slice(0, low);
}

function utf8Suffix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), "utf8") <= maxBytes) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  while (low < value.length && /[\uDC00-\uDFFF]/.test(value[low] ?? "")) {
    low += 1;
  }
  return value.slice(low);
}

function truncateLongOutputLine(line: string): string {
  const originalBytes = Buffer.byteLength(line, "utf8");
  if (originalBytes <= MAX_GREP_OUTPUT_LINE_BYTES) {
    return line;
  }
  const marker = ` … [grep line truncated: ${originalBytes} bytes] … `;
  const contentBudget = MAX_GREP_OUTPUT_LINE_BYTES - Buffer.byteLength(marker, "utf8");
  const prefixBudget = Math.ceil((contentBudget * 2) / 3);
  const suffixBudget = contentBudget - prefixBudget;
  return `${utf8Prefix(line, prefixBudget)}${marker}${utf8Suffix(line, suffixBudget)}`;
}

function truncateTotalOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_GREP_OUTPUT_BYTES) {
    return text;
  }
  const marker =
    `\n... [grep output truncated at ${MAX_GREP_OUTPUT_BYTES} bytes; ` +
    "narrow the query or file pattern]";
  const contentBudget = MAX_GREP_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8");
  const bounded = utf8Prefix(text, contentBudget);
  const lastNewline = bounded.lastIndexOf("\n");
  const completeLines = lastNewline >= 0 ? bounded.slice(0, lastNewline) : bounded;
  return `${completeLines}${marker}`;
}

function truncateOutput(text: string, maxLines = TRUNCATE_MAX_LINES): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split("\n").map(truncateLongOutputLine);
  if (lines.length <= maxLines) {
    return trimmed.length > 0 ? truncateTotalOutput(lines.join("\n")) : text;
  }
  return truncateTotalOutput(
    [...lines.slice(0, maxLines), `... (+${lines.length - maxLines} more matches truncated)`].join(
      "\n",
    ),
  );
}

function execFileStdout(
  cmd: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; kind: "missing" | "other" } {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      cwd: getWorkspaceFiles().getRoot(),
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: typeof stdout === "string" ? stdout : String(stdout) };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string | Buffer; code?: string };
    if (err.code === "ENOENT") {
      return { ok: false, kind: "missing" };
    }
    // ripgrep / git grep: exit 1 == no matches; stdout may still be empty
    if (err.status === 1) {
      const raw =
        typeof err.stdout === "string"
          ? err.stdout
          : err.stdout != null
            ? err.stdout.toString("utf8")
            : "";
      return { ok: true, stdout: raw };
    }
    return { ok: false, kind: "other" };
  }
}

/** Result of one native backend (rg / git grep). */
type NativeSearchOutcome =
  | { kind: "hits"; text: string }
  | { kind: "empty" }
  | { kind: "unavailable" };

/**
 * Git pathspec does not perform shell brace expansion; patterns like `*.{ts,tsx}` are literal.
 * Expand a trailing `.{a,b,c}` suffix (common LLM / Bash style) into separate pathspecs for git grep.
 * Nested or multiple brace groups are not expanded here; pass through as a single pathspec.
 */
function expandGitGrepPathspecs(filePattern: string): string[] {
  const braceSuffix = filePattern.match(/^(.*)\.\{([^}]+)\}$/);
  if (!braceSuffix) {
    return [filePattern];
  }
  const prefix = braceSuffix[1];
  const exts = braceSuffix[2]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (exts.length === 0) {
    return [filePattern];
  }
  return exts.map((ext) => `${prefix}.${ext}`);
}

function clampContextLines(contextLines?: number): number {
  if (!Number.isFinite(contextLines)) {
    return DEFAULT_CONTEXT_LINES;
  }
  return Math.max(0, Math.min(MAX_CONTEXT_LINES, Math.trunc(contextLines as number)));
}

type SearchLine = {
  lineNumber: number;
  text: string;
  matched: boolean;
};

type SearchFileResult = {
  displayPath: string;
  lines: Map<number, SearchLine>;
  matchedLineNumbers: Set<number>;
};

function createSearchFileResult(displayPath: string): SearchFileResult {
  return {
    displayPath,
    lines: new Map(),
    matchedLineNumbers: new Set(),
  };
}

function addSearchLine(
  result: SearchFileResult,
  lineNumber: number,
  text: string,
  matched: boolean,
): void {
  const existing = result.lines.get(lineNumber);
  result.lines.set(lineNumber, {
    lineNumber,
    text: existing?.text ?? text,
    matched: Boolean(existing?.matched || matched),
  });
  if (matched) {
    result.matchedLineNumbers.add(lineNumber);
  }
}

function mergeContextIntervals(
  matchedLineNumbers: Iterable<number>,
  contextLines: number,
): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  const normalizedContextLines = clampContextLines(contextLines);
  const sortedMatches = [...new Set(matchedLineNumbers)].sort((a, b) => a - b);

  for (const lineNumber of sortedMatches) {
    const start = Math.max(1, lineNumber - normalizedContextLines);
    const end = lineNumber + normalizedContextLines;
    const previous = intervals.at(-1);
    // Merge overlapping windows and a one-line gap. The latter avoids emitting
    // two nearly identical snippets for matches separated by one line.
    if (previous && start <= previous[1] + 2) {
      previous[1] = Math.max(previous[1], end);
    } else {
      intervals.push([start, end]);
    }
  }
  return intervals;
}

function parseNativeSearchOutput(text: string): SearchFileResult[] {
  const files = new Map<string, SearchFileResult>();

  for (const rawLine of text.trimEnd().split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line === "--") {
      continue;
    }

    // Native context uses path-line-text while a match uses path:line:text.
    // Choose the delimiter that occurs first so a context line containing
    // another colon (for example, a URL) is not mistaken for a match.
    const matchingDelimiter = line.match(/:(\d+):/);
    const contextDelimiter = line.match(/-(\d+)-/);
    const matchingIndex = matchingDelimiter?.index ?? Number.POSITIVE_INFINITY;
    const contextIndex = contextDelimiter?.index ?? Number.POSITIVE_INFINITY;
    const isMatch = matchingIndex < contextIndex;
    const delimiter = isMatch ? matchingDelimiter : contextDelimiter;
    const delimiterIndex = isMatch ? matchingIndex : contextIndex;
    if (!delimiter || !Number.isFinite(delimiterIndex)) {
      continue;
    }

    const displayPath = line.slice(0, delimiterIndex);
    const lineNumber = Number(delimiter[1]);
    const lineText = line.slice(delimiterIndex + delimiter[0].length);
    if (!displayPath || !Number.isSafeInteger(lineNumber) || lineNumber < 1) {
      continue;
    }

    let result = files.get(displayPath);
    if (!result) {
      result = createSearchFileResult(displayPath);
      files.set(displayPath, result);
    }
    addSearchLine(result, lineNumber, lineText, isMatch);
  }

  return [...files.values()];
}

function renderSearchResults(results: SearchFileResult[], contextLines: number): string {
  const outputLines: string[] = [];
  let renderedAnyFile = false;

  for (const result of results) {
    const intervals = mergeContextIntervals(result.matchedLineNumbers, contextLines);
    let renderedFile = false;

    for (const [start, end] of intervals) {
      const lines = [...result.lines.values()]
        .filter((line) => line.lineNumber >= start && line.lineNumber <= end)
        .sort((a, b) => a.lineNumber - b.lineNumber);
      if (lines.length === 0) {
        continue;
      }

      if (!renderedFile) {
        if (renderedAnyFile) {
          outputLines.push("--");
        }
        outputLines.push(result.displayPath);
        renderedFile = true;
        renderedAnyFile = true;
      } else {
        outputLines.push("--");
      }

      for (const line of lines) {
        const marker = line.matched ? ">" : " ";
        outputLines.push(`${marker} ${line.lineNumber} | ${line.text}`);
      }
    }
  }

  return outputLines.length > 0 ? truncateOutput(outputLines.join("\n")) : "";
}

function rgExcludeGlobs(): string[] {
  return [...TOOL_ALWAYS_IGNORED_DIR_NAMES].flatMap((name) => ["--glob", `!${name}/**`]);
}

function gitExcludePathspecs(): string[] {
  return [...TOOL_ALWAYS_IGNORED_DIR_NAMES].map((name) => `:(exclude)${name}`);
}

function runRipgrep(
  query: string,
  filePattern?: string,
  contextLines = DEFAULT_CONTEXT_LINES,
): NativeSearchOutcome {
  // Keep native backends consistent: git grep and Node fallback both search case-insensitively.
  // NB: ripgrep's -I means --no-filename (it would cancel -H); ripgrep already skips binary files
  // by default, so the binary-skip intent needs no flag here.
  const args = [
    "-n",
    "-H",
    "-i",
    "--max-columns",
    String(MAX_GREP_OUTPUT_LINE_BYTES),
    "--max-columns-preview",
    query,
    ...rgExcludeGlobs(),
  ];
  args.push("-C", String(clampContextLines(contextLines)));
  if (filePattern) {
    args.push("-g", filePattern);
  }
  const result = execFileStdout("rg", args);
  if (!result.ok) {
    return { kind: "unavailable" };
  }
  const out = renderSearchResults(
    parseNativeSearchOutput(result.stdout),
    clampContextLines(contextLines),
  );
  return out.trim().length > 0 ? { kind: "hits", text: out } : { kind: "empty" };
}

function runGitGrep(
  query: string,
  filePattern?: string,
  contextLines = DEFAULT_CONTEXT_LINES,
): NativeSearchOutcome {
  // -i: ignore case (match ripgrep-less environments where we rely on git grep + Node fallback)
  const args = [
    "grep",
    "-n",
    "-I",
    "-i",
    "-E",
    "-e",
    query,
    "-C",
    String(clampContextLines(contextLines)),
  ];
  if (filePattern) {
    const pathspecs = expandGitGrepPathspecs(filePattern);
    args.push("--", ...gitExcludePathspecs(), ...pathspecs);
  } else {
    args.push("--", ".", ...gitExcludePathspecs());
  }
  const result = execFileStdout("git", args);
  if (!result.ok) {
    return { kind: "unavailable" };
  }
  const out = renderSearchResults(
    parseNativeSearchOutput(result.stdout),
    clampContextLines(contextLines),
  );
  return out.trim().length > 0 ? { kind: "hits", text: out } : { kind: "empty" };
}

async function collectFiles(
  policy: WorkspaceFiles,
  directory: ResolvedFsPath,
  includeIgnored: boolean,
  fileList: ResolvedFsPath[] = [],
  state: { visitedEntries: number } = { visitedEntries: 0 },
): Promise<ResolvedFsPath[]> {
  if (
    fileList.length >= MAX_FALLBACK_FILES ||
    (includeIgnored && state.visitedEntries >= MAX_SCOPED_IGNORED_ENTRIES)
  ) {
    return fileList;
  }
  let entries: WorkspaceDirEntry[];
  try {
    entries = await policy.readdirResolved(directory, { withFileTypes: true });
  } catch {
    return fileList;
  }
  for (const entry of entries) {
    if (
      fileList.length >= MAX_FALLBACK_FILES ||
      (includeIgnored && state.visitedEntries >= MAX_SCOPED_IGNORED_ENTRIES)
    ) {
      break;
    }
    state.visitedEntries += 1;
    if (
      includeIgnored
        ? policy.shouldSkipScopedResolvedEntry(directory, entry)
        : policy.shouldSkipResolvedEntry(directory, entry)
    ) {
      continue;
    }
    const child = policy.childResolved(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(policy, child, includeIgnored, fileList, state);
      continue;
    }
    fileList.push(child);
  }
  return fileList;
}

/**
 * Match relative file paths against a glob (brace expansion, **, etc.) using picomatch.
 * When the pattern has no path segment, also prepends "any depth" (like ** /) so extension-only globs match like ripgrep -g.
 */
function matchGlob(fileRel: string, pattern?: string): boolean {
  if (!pattern) {
    return true;
  }
  const posixPath = fileRel.split(path.sep).join("/");
  const base = path.basename(fileRel);
  const opts = { dot: true } as const;
  const primary = picomatch(pattern, opts);
  if (primary(posixPath) || primary(base)) {
    return true;
  }
  if (!pattern.includes("/")) {
    return picomatch(`**/${pattern}`, opts)(posixPath);
  }
  return false;
}

async function fallbackNodeSearch(
  query: string,
  filePattern?: string,
  contextLines = DEFAULT_CONTEXT_LINES,
  options: GrepSearchOptions = {},
): Promise<string> {
  const policy = getWorkspaceFiles();
  let re: RegExp;
  try {
    re = new RegExp(query, "i");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Invalid regex for Node fallback: ${msg}`;
  }

  const directory = options.directory ?? ".";
  const includeIgnored = options.includeIgnored ?? false;
  const resolved = await resolveFileToolPath(directory, { kind: "scan", includeIgnored });
  if (!resolved.ok) {
    return `grep failed: ${resolved.error}`;
  }
  if (includeIgnored) {
    const scopeError = policy.validateScopedDiscoveryRoot(resolved);
    if (scopeError) {
      return `grep failed: ${scopeError}`;
    }
  }
  let searchRootIsDirectory: boolean;
  try {
    const stat = await policy.statResolved(resolved);
    searchRootIsDirectory = stat.isDirectory();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `grep failed: ${msg}`;
  }

  // `directory` remains the agent-facing contract, but agents sometimes pass a concrete file while
  // narrowing a search. Treat that as a single-file scan instead of rejecting an otherwise safe path.
  const allFiles = searchRootIsDirectory
    ? await collectFiles(policy, resolved, includeIgnored)
    : [resolved];
  const searchResults: SearchFileResult[] = [];
  const normalizedContextLines = clampContextLines(contextLines);

  for (const file of allFiles) {
    if (!matchGlob(file.rel, filePattern)) {
      continue;
    }
    let content: string;
    try {
      const stat = await policy.statResolved(file);
      if (stat.size > MAX_FALLBACK_FILE_BYTES) {
        continue;
      }
      content = await policy.readResolved(file);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const matchedLineNumbers = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matchedLineNumbers.add(i + 1);
      }
    }

    if (matchedLineNumbers.size === 0) {
      continue;
    }

    const result = createSearchFileResult(file.displayPath);
    for (const [start, end] of mergeContextIntervals(matchedLineNumbers, normalizedContextLines)) {
      for (let lineNumber = start; lineNumber <= end; lineNumber++) {
        const lineText = lines[lineNumber - 1];
        if (lineText !== undefined) {
          addSearchLine(result, lineNumber, lineText, matchedLineNumbers.has(lineNumber));
        }
      }
    }
    searchResults.push(result);
  }

  const rendered = renderSearchResults(searchResults, normalizedContextLines);
  if (rendered.length === 0) {
    return includeIgnored
      ? "No matches for pattern (bounded ignored-subtree scan; skipped nested tool dirs and oversized files)."
      : "No matches for pattern (Node fallback; skipped by .gitignore, tool dirs, and oversized files).";
  }
  return rendered;
}

/** Shared ripgrep / git grep / Node fallback pipeline (also used by planner-scoped grep). */
export interface GrepSearchOptions {
  directory?: string;
  includeIgnored?: boolean;
}

export async function executeGrepSearch(
  query: string,
  filePattern?: string,
  contextLines = DEFAULT_CONTEXT_LINES,
  options: GrepSearchOptions = {},
): Promise<string> {
  if ((options.directory ?? ".") !== "." || options.includeIgnored) {
    return await fallbackNodeSearch(query, filePattern, contextLines, options);
  }
  const rg = runRipgrep(query, filePattern, contextLines);
  if (rg.kind !== "unavailable") {
    return rg.kind === "hits" ? rg.text : "No matches found (ripgrep).";
  }

  const git = runGitGrep(query, filePattern, contextLines);
  if (git.kind !== "unavailable") {
    return git.kind === "hits" ? git.text : "No matches found (git grep).";
  }

  return await fallbackNodeSearch(query, filePattern, contextLines, options);
}

export const GrepSearchTool: ToolDefinition<typeof GrepSearchSchema> = {
  name: "grep",
  description:
    "Search files for text or regex patterns (like grep/ripgrep) to find usages and definitions. " +
    "Skips node_modules and .git. Uses ripgrep when available, then git grep if rg is missing, then a bounded Node scan only if both native tools are unavailable. " +
    "Native tools mostly respect .gitignore; git grep expands trailing `*.{ext,...}` style globs into multiple pathspecs. " +
    "Use directory plus includeIgnored for a bounded ignored-subtree search; node_modules requires a concrete package path. " +
    "Supports configurable context lines (default 3, max 12). " +
    `Every output line is capped at ${MAX_GREP_OUTPUT_LINE_BYTES / 1024} KB; oversized matching or context lines retain their beginning and end with a truncation marker. ` +
    `The complete response is capped at ${MAX_GREP_OUTPUT_BYTES / 1024} KB. ` +
    "The Node fallback uses case-insensitive JavaScript RegExp (`i` flag) and picomatch for filePattern.",
  parameters: GrepSearchSchema,
  handler: async ({ query, filePattern, contextLines, directory, includeIgnored }) => {
    return executeGrepSearch(query, filePattern, contextLines, { directory, includeIgnored });
  },
};
