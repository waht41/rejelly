/**
 * Fuzzy-search service: lists candidate file paths under a workspace directory
 * via ripgrep → git → Node fallback, then scores/ranks them against a keyword.
 * Extracted from FuzzySearchTool for reuse by the CLI file picker and other consumers.
 */

import { execFileSync } from "node:child_process";
import {
  getWorkspaceFsPolicy,
  type ResolvedFsPath,
  TOOL_ALWAYS_IGNORED_DIR_NAMES,
  toGitignorePath,
  type WorkspaceDirEntry,
  type WorkspaceFsPolicy,
} from "../../../shared/fs-policy/workspace-fs-policy";
import { resolveFileToolPath } from "./outsideAccess";

/** Hard cap on collected file paths to bound work on huge trees. */
const MAX_COLLECT = 200_000;
/** Hard cap on files visited by the Node fallback walk (git path has its own bound). */
const MAX_FALLBACK_FILES = 50_000;
/** Tighter caps for opt-in traversal of ignored/generated/dependency subtrees. */
const MAX_SCOPED_IGNORED_FILES = 10_000;
const MAX_SCOPED_IGNORED_ENTRIES = 50_000;

// ---------------------------------------------------------------------------
// Internal helpers (identical to the original FuzzySearchTool)
// ---------------------------------------------------------------------------

/** Whether the character at `cur` starts a new "word" given the previous char (boundary or camelCase). */
function isWordStart(prevChar: string, curChar: string): boolean {
  if (prevChar === "/" || prevChar === "\\" || prevChar === "_" || prevChar === "-") {
    return true;
  }
  if (prevChar === "." || prevChar === " ") {
    return true;
  }
  // camelCase hump: lower/digit followed by upper.
  return (
    prevChar.toLowerCase() === prevChar && curChar.toUpperCase() === curChar && curChar !== prevChar
  );
}

/**
 * Greedy subsequence score of `needleLower` inside `candidate`. Returns null when not all needle
 * characters appear in order. Higher is better. Boundary/basename/consecutive matches score more,
 * longer paths are penalised slightly so shorter matches win on ties.
 */
function scorePath(needleLower: string, candidate: string): number | null {
  const hay = candidate.toLowerCase();
  const baseStart = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\")) + 1;

  let needleIdx = 0;
  let prevMatch = -2;
  let consecutive = 0;
  let score = 0;

  for (let i = 0; i < hay.length && needleIdx < needleLower.length; i++) {
    if (hay[i] !== needleLower[needleIdx]) {
      continue;
    }
    let bonus = 1;
    if (i === prevMatch + 1) {
      consecutive += 1;
      bonus += consecutive * 2;
    } else {
      consecutive = 0;
    }
    const prevChar = i > 0 ? candidate[i - 1] : "/";
    if (isWordStart(prevChar, candidate[i])) {
      bonus += 3;
    }
    if (i >= baseStart) {
      bonus += 2;
    }
    score += bonus;
    prevMatch = i;
    needleIdx += 1;
  }

  if (needleIdx < needleLower.length) {
    return null;
  }
  // Prefer shorter paths on otherwise-equal matches.
  return score - candidate.length * 0.05;
}

/** Reject paths whose segments hit an always-ignored dir name (mirrors the Node walk guard). */
function hasIgnoredSegment(rootRelPosix: string): boolean {
  for (const seg of rootRelPosix.split("/")) {
    if (TOOL_ALWAYS_IGNORED_DIR_NAMES.has(seg)) {
      return true;
    }
  }
  return false;
}

/** Normalise raw backend output to workspace-root-relative posix paths, dropping ignored segments. */
function collectFiltered(entries: Iterable<string>): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const p = toGitignorePath(entry);
    if (p.length === 0 || hasIgnoredSegment(p)) {
      continue;
    }
    out.push(p);
    if (out.length >= MAX_COLLECT) {
      break;
    }
  }
  return out;
}

/**
 * List candidate file paths under `dirRelPosix` via `rg --files`.
 * Returns null when ripgrep is not installed so callers fall back to git.
 */
function rgListFiles(dirRelPosix: string): string[] | null {
  const args =
    dirRelPosix === "" || dirRelPosix === "." ? ["--files"] : ["--files", "--", dirRelPosix];
  try {
    const stdout = execFileSync("rg", args, {
      cwd: getWorkspaceFsPolicy().getRoot(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return collectFiltered(stdout.split(/\r?\n/));
  } catch (e: unknown) {
    const err = e as { code?: string; status?: number; stdout?: string | Buffer };
    if (err.code === "ENOENT") {
      return null;
    }
    if (err.status === 1) {
      const raw =
        typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
      return collectFiltered(raw.split(/\r?\n/));
    }
    return null;
  }
}

/**
 * List candidate file paths (workspace-root-relative, posix) under `dirRelPosix` via git.
 * Returns null when git is unavailable or this is not a git repo, so callers fall back to Node.
 */
function gitListFiles(dirRelPosix: string): string[] | null {
  const pathspec = dirRelPosix === "" || dirRelPosix === "." ? "." : dirRelPosix;
  try {
    const stdout = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", pathspec],
      {
        cwd: getWorkspaceFsPolicy().getRoot(),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return collectFiltered(stdout.split("\0"));
  } catch {
    return null;
  }
}

/** Bounded Node directory walk honouring root .gitignore and always-ignored dir names. */
async function nodeWalkFiles(
  policy: WorkspaceFsPolicy,
  start: ResolvedSearchDirectory,
  includeIgnored: boolean,
): Promise<string[]> {
  const maxFiles = includeIgnored ? MAX_SCOPED_IGNORED_FILES : MAX_FALLBACK_FILES;
  const out: string[] = [];
  let visitedEntries = 0;

  async function visit(directory: ResolvedSearchDirectory): Promise<void> {
    if (
      out.length >= maxFiles ||
      (includeIgnored && visitedEntries >= MAX_SCOPED_IGNORED_ENTRIES)
    ) {
      return;
    }
    let entries: WorkspaceDirEntry[];
    try {
      entries = await policy.readdirResolved(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        out.length >= maxFiles ||
        (includeIgnored && visitedEntries >= MAX_SCOPED_IGNORED_ENTRIES)
      ) {
        return;
      }
      visitedEntries += 1;
      if (
        includeIgnored
          ? policy.shouldSkipScopedResolvedEntry(directory, entry)
          : policy.shouldSkipResolvedEntry(directory, entry)
      ) {
        continue;
      }
      const child = policy.childResolved(directory, entry.name);
      if (entry.isDirectory()) {
        await visit({ ...child, relPosix: toGitignorePath(child.rel), mtimeMs: 0 });
        continue;
      }
      out.push(toGitignorePath(child.outside ? child.displayPath : child.rel));
    }
  }

  await visit(start);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FuzzyMatch {
  /** Workspace-relative path for workspace hits; absolute path for approved outside hits. */
  path: string;
  /** Internal ranking score (higher = better match). */
  score: number;
}

export interface FuzzyPathRefMatch extends FuzzyMatch {
  kind: "file" | "directory";
}

type ResolvedSearchDirectory = ResolvedFsPath & {
  relPosix: string;
  mtimeMs: number;
};

type CandidateCacheEntry = {
  mtimeMs: number;
  candidates: string[];
};

export type FuzzySearchOptions = {
  /**
   * `refresh` bypasses a cached candidate snapshot and replaces it with a fresh scan.
   * `reuse` keeps repeated interactive queries fast by scoring the existing snapshot.
   */
  cachePolicy?: "reuse" | "refresh";
  /** Traverse one explicitly selected ignored subtree with tighter Node-walk bounds. */
  includeIgnored?: boolean;
};

const candidateCache = new Map<string, CandidateCacheEntry>();

function normalizeDirectoryRel(rel: string): string {
  const normalized = toGitignorePath(rel);
  return normalized === "" ? "." : normalized;
}

async function resolveSearchDirectory(
  policy: WorkspaceFsPolicy,
  directory: string,
  includeIgnored: boolean,
): Promise<ResolvedSearchDirectory> {
  const resolved = await resolveFileToolPath(directory, { kind: "scan", includeIgnored });
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }
  if (includeIgnored) {
    const scopeError = policy.validateScopedDiscoveryRoot(resolved);
    if (scopeError) {
      throw new Error(scopeError);
    }
  }
  const stat = await policy.statResolved(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Search directory is not a directory: ${resolved.rel}`);
  }
  return {
    abs: resolved.abs,
    rel: resolved.rel,
    displayPath: resolved.displayPath,
    outside: resolved.outside,
    relPosix: normalizeDirectoryRel(resolved.rel),
    mtimeMs: stat.mtimeMs,
  };
}

async function getCandidateFiles(
  directory: string,
  cachePolicy: FuzzySearchOptions["cachePolicy"] = "reuse",
  includeIgnored = false,
): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const resolved = await resolveSearchDirectory(policy, directory, includeIgnored);
  const cacheKey = `${policy.getRoot()}\0${includeIgnored ? "ignored" : "default"}\0${resolved.relPosix}`;
  const cached = candidateCache.get(cacheKey);
  if (cachePolicy === "reuse" && cached && cached.mtimeMs === resolved.mtimeMs) {
    return cached.candidates;
  }

  const candidates =
    includeIgnored || resolved.outside
      ? await nodeWalkFiles(policy, resolved, includeIgnored)
      : (rgListFiles(resolved.relPosix) ??
        gitListFiles(resolved.relPosix) ??
        (await nodeWalkFiles(policy, resolved, false)));
  candidateCache.set(cacheKey, { mtimeMs: resolved.mtimeMs, candidates });
  return candidates;
}

function collectParentDirectories(rootRelPaths: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const rootRelPath of rootRelPaths) {
    const segments = rootRelPath.split("/").filter((segment) => segment.length > 0);
    for (let i = 1; i < segments.length; i += 1) {
      seen.add(segments.slice(0, i).join("/"));
    }
  }
  return [...seen];
}

function normalizePathRefNeedle(keyword: string): string {
  return toGitignorePath(keyword.trim()).replace(/\/+$/, "").toLowerCase();
}

async function exactDirectoryCandidate(keyword: string): Promise<string | null> {
  const policy = getWorkspaceFsPolicy();
  const normalized = normalizeDirectoryRel(normalizePathRefNeedle(keyword));
  if (normalized === ".") {
    return null;
  }
  const resolved = policy.tryResolveWorkspacePath(normalized);
  if (!resolved.ok) {
    return null;
  }
  try {
    const stat = await policy.stat(resolved.rel);
    return stat.isDirectory() ? normalizeDirectoryRel(resolved.rel) : null;
  } catch {
    return null;
  }
}

export function resetFuzzySearchCache(): void {
  candidateCache.clear();
}

export function getFuzzySearchCacheSize(): number {
  return candidateCache.size;
}

/**
 * Collect candidate file paths under the given directory, score them against `keyword`,
 * and return the top `limit` results sorted by relevance (best first).
 *
 * @param keyword  Fuzzy needle for file paths (non-contiguous character matches allowed).
 * @param directory  Workspace-relative directory to scan. Defaults to ".".
 * @param limit  Maximum number of paths to return (default 20, cap 100).
 */
export async function fuzzySearchFiles(
  keyword: string,
  directory: string = ".",
  limit?: number,
  options?: FuzzySearchOptions,
): Promise<FuzzyMatch[]> {
  const maxResults = Math.min(Math.max(limit ?? 20, 1), 100);
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const rootRelPaths = await getCandidateFiles(
    directory,
    options?.cachePolicy,
    options?.includeIgnored,
  );

  const scored: Array<{ path: string; score: number }> = [];
  for (const rootRel of rootRelPaths) {
    const score = scorePath(needle, rootRel);
    if (score !== null) {
      scored.push({ path: rootRel, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, maxResults);
}

/**
 * Fuzzy search over attachable @-refs. Unlike fuzzySearchFiles, this includes
 * directories so selecting @src can attach a default directory listing.
 */
export async function fuzzySearchPathRefs(
  keyword: string,
  directory: string = ".",
  limit?: number,
  options?: FuzzySearchOptions,
): Promise<FuzzyPathRefMatch[]> {
  const maxResults = Math.min(Math.max(limit ?? 20, 1), 100);
  const needle = normalizePathRefNeedle(keyword);
  if (needle.length === 0) {
    return [];
  }

  const rootRelFiles = await getCandidateFiles(directory, options?.cachePolicy);
  const rootRelDirectories = collectParentDirectories(rootRelFiles);
  const exactDirectory = await exactDirectoryCandidate(keyword);
  if (exactDirectory && !rootRelDirectories.includes(exactDirectory)) {
    rootRelDirectories.push(exactDirectory);
  }

  const scored: FuzzyPathRefMatch[] = [];
  for (const rootRel of rootRelDirectories) {
    const score = scorePath(needle, rootRel);
    if (score !== null) {
      scored.push({ path: rootRel, score: score + 1, kind: "directory" });
    }
  }
  for (const rootRel of rootRelFiles) {
    const score = scorePath(needle, rootRel);
    if (score !== null) {
      scored.push({ path: rootRel, score, kind: "file" });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, maxResults);
}

/**
 * Synchronous version of fuzzySearchFiles for use in places where
 * a full async call is not needed (e.g. pre-collected file lists).
 * This variant scores already-collected path strings.
 */
export function fuzzyScorePaths(keyword: string, candidates: string[]): FuzzyMatch[] {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const scored: FuzzyMatch[] = [];
  for (const candidate of candidates) {
    const score = scorePath(needle, candidate);
    if (score !== null) {
      scored.push({ path: candidate, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored;
}
