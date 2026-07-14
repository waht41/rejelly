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
  getWorkspaceFsPolicy,
  TOOL_ALWAYS_IGNORED_DIR_NAMES,
  type WorkspaceDirEntry,
  type WorkspaceFsPolicy,
} from "../shared/fs-policy/workspace-fs-policy";

const MAX_FALLBACK_FILE_BYTES = 200 * 1024;
const MAX_FALLBACK_FILES = 8000;
const TRUNCATE_MAX_LINES = 300;
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
});

function truncateOutput(text: string, maxLines = TRUNCATE_MAX_LINES): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split("\n");
  if (lines.length <= maxLines) {
    return trimmed.length > 0 ? trimmed : text;
  }
  return [
    ...lines.slice(0, maxLines),
    `... (+${lines.length - maxLines} more matches truncated)`,
  ].join("\n");
}

function execFileStdout(
  cmd: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; kind: "missing" | "other" } {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      cwd: getWorkspaceFsPolicy().getRoot(),
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
  const args = ["-n", "-H", "-i", query, ...rgExcludeGlobs()];
  args.push("-C", String(clampContextLines(contextLines)));
  if (filePattern) {
    args.push("-g", filePattern);
  }
  const result = execFileStdout("rg", args);
  if (!result.ok) {
    return { kind: "unavailable" };
  }
  const out = truncateOutput(result.stdout);
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
  const out = truncateOutput(result.stdout);
  return out.trim().length > 0 ? { kind: "hits", text: out } : { kind: "empty" };
}

async function collectFiles(
  policy: WorkspaceFsPolicy,
  relativeDir: string,
  fileList: string[] = [],
): Promise<string[]> {
  if (fileList.length >= MAX_FALLBACK_FILES) {
    return fileList;
  }
  let entries: WorkspaceDirEntry[];
  try {
    entries = await policy.readdir(relativeDir, { withFileTypes: true });
  } catch {
    return fileList;
  }
  for (const entry of entries) {
    if (fileList.length >= MAX_FALLBACK_FILES) {
      break;
    }
    const childRel = path.join(relativeDir, entry.name);
    if (policy.shouldSkipIgnoredWorkspaceEntry(relativeDir, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectFiles(policy, childRel, fileList);
      continue;
    }
    fileList.push(childRel);
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
): Promise<string> {
  const policy = getWorkspaceFsPolicy();
  let re: RegExp;
  try {
    re = new RegExp(query, "i");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Invalid regex for Node fallback: ${msg}`;
  }

  const allFiles = await collectFiles(policy, ".");
  const linesOut: string[] = [];
  const normalizedContextLines = clampContextLines(contextLines);

  for (const fileRel of allFiles) {
    if (!matchGlob(fileRel, filePattern)) {
      continue;
    }
    let content: string;
    try {
      const stat = await policy.stat(fileRel);
      if (stat.size > MAX_FALLBACK_FILE_BYTES) {
        continue;
      }
      content = await policy.readFile(fileRel);
    } catch {
      continue;
    }
    const rel = fileRel;
    const lines = content.split(/\r?\n/);
    const matchedLineIndexes = new Set<number>();
    const contextLineIndexes = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matchedLineIndexes.add(i);
        const start = Math.max(0, i - normalizedContextLines);
        const end = Math.min(lines.length - 1, i + normalizedContextLines);
        for (let idx = start; idx <= end; idx++) {
          contextLineIndexes.add(idx);
        }
      }
    }

    if (contextLineIndexes.size === 0) {
      continue;
    }

    const selectedIndexes = Array.from(contextLineIndexes).sort((a, b) => a - b);
    let prev = -2;
    for (const idx of selectedIndexes) {
      if (prev !== -2 && idx > prev + 1) {
        linesOut.push("--");
      }
      if (matchedLineIndexes.has(idx)) {
        linesOut.push(`${rel}:${idx + 1}:${lines[idx]}`);
      } else {
        linesOut.push(`${rel}-${idx + 1}-${lines[idx]}`);
      }
      prev = idx;
      if (linesOut.length >= TRUNCATE_MAX_LINES) {
        return truncateOutput(linesOut.join("\n"));
      }
    }
  }

  if (linesOut.length === 0) {
    return "No matches for pattern (Node fallback; skipped by .gitignore, tool dirs, and oversized files).";
  }
  return truncateOutput(linesOut.join("\n"));
}

/** Shared ripgrep / git grep / Node fallback pipeline (also used by planner-scoped grep). */
export async function executeGrepSearch(
  query: string,
  filePattern?: string,
  contextLines = DEFAULT_CONTEXT_LINES,
): Promise<string> {
  const rg = runRipgrep(query, filePattern, contextLines);
  if (rg.kind !== "unavailable") {
    return rg.kind === "hits" ? rg.text : "No matches found (ripgrep).";
  }

  const git = runGitGrep(query, filePattern, contextLines);
  if (git.kind !== "unavailable") {
    return git.kind === "hits" ? git.text : "No matches found (git grep).";
  }

  return await fallbackNodeSearch(query, filePattern, contextLines);
}

export const GrepSearchTool: ToolDefinition<typeof GrepSearchSchema> = {
  name: "grep",
  description:
    "Search the codebase for text or regex patterns (like grep/ripgrep) to find usages and definitions. " +
    "Skips node_modules and .git. Uses ripgrep when available, then git grep if rg is missing, then a bounded Node scan only if both native tools are unavailable. " +
    "Native tools mostly respect .gitignore; git grep expands trailing `*.{ext,...}` style globs into multiple pathspecs. " +
    "Supports configurable context lines (default 3, max 12). " +
    "The Node fallback uses case-insensitive JavaScript RegExp (`i` flag) and picomatch for filePattern.",
  parameters: GrepSearchSchema,
  handler: async ({ query, filePattern, contextLines }) => {
    return executeGrepSearch(query, filePattern, contextLines);
  },
};
