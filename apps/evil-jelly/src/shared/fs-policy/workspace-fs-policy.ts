/**
 * Workspace filesystem policy for agent tools: path jailing and hidden agent-only dirs.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { getErrnoCode } from "../foundation/errno";
import { isPathInside, OutsideAccessRegistry, suggestOutsideApproveDir } from "./outside-access";

/**
 * Duck type for one directory entry from readdir (no dependency on node:fs.Dirent).
 */
export type WorkspaceDirEntry = {
  name: string;
  isDirectory: () => boolean;
  isSymbolicLink?: () => boolean;
};

export interface WorkspaceWalkFilesOptions {
  /** Workspace-relative files or directories to traverse. Missing and denied roots are skipped. */
  roots?: readonly string[];
  /** Maximum number of matching files returned. */
  maxFiles: number;
  /** Hard ceiling on directory entries inspected, including ignored entries. */
  maxEntries?: number;
  /** Domain-owned selection applied after filesystem policy checks. */
  includeFile?: (workspaceRelativePosix: string) => boolean;
}

export type FsIntent = "inside" | "read" | "write";
export type FsApprovalMode = "normal" | "auto";

export type ResolvedFsPath = {
  abs: string;
  rel: string;
  displayPath: string;
  outside: boolean;
};

export type FsResolveResult =
  | ({ ok: true } & ResolvedFsPath)
  | {
      ok: false;
      error: string;
      needsApproval?: boolean;
      mode?: Exclude<FsIntent, "inside">;
      targetPath?: string;
      approveDir?: string;
    };

/**
 * Directory name segments that must not be exposed to the agent (list/read/write/search).
 * Matches any path segment, e.g. repo/.agents/skills is blocked.
 */
export const AGENT_HIDDEN_NAMES = new Set([
  ".agents",
  ".cursor",
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

/**
 * Directory names skipped during traversal before applying root `.gitignore`.
 * This is traversal policy, not the full resolve guard: `.env` is sensitive as a file pattern,
 * while `coverage` is hidden from direct agent access but not hard-skipped by tool walks.
 */
export const TOOL_ALWAYS_IGNORED_DIR_NAMES = new Set([
  ".agents",
  ".cursor",
  ".git",
  ".next",
  ".env",
  "node_modules",
  "dist",
  "build",
]);

export const SENSITIVE_FILE_PATTERNS = [/^\.env(\..+)?$/i, /\.pem$/i, /id_rsa/i, /\.npmrc$/i];
const SAFE_ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template"]);

/**
 * The app's own state dir (audit ledger/reports, session data). Being gitignored is its normal
 * state, so the gitignore jail must not apply to it — otherwise audit could never persist its
 * ledger in a properly-configured repo. Still subject to the root jail and sensitive-file blocks.
 */
export const EVIL_JELLY_STATE_DIR = ".evil-jelly";
export const AGENT_SCRATCH_DIR = `${EVIL_JELLY_STATE_DIR}/tmp`;
const DEFAULT_MAX_WORKSPACE_WALK_ENTRIES = 100_000;

export function toGitignorePath(relativeNormalized: string): string {
  let p = relativeNormalized.replace(/\\/g, "/");
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}

function isEnvTemplateFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.startsWith(".env.")) {
    return false;
  }
  const suffix = lower.slice(lower.lastIndexOf(".") + 1);
  return SAFE_ENV_TEMPLATE_SUFFIXES.has(suffix);
}

function isSensitiveFileName(fileName: string): boolean {
  if (isEnvTemplateFileName(fileName)) {
    return false;
  }
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function sensitiveFileError(displayPath: string): string {
  return (
    `Access denied: Path '${displayPath}' matches a sensitive file pattern. ` +
    "If you explicitly need to inspect it, ask the user to run the command via run_command."
  );
}

function isPathSystemHidden(relativeNormalized: string): boolean {
  const parts = relativeNormalized.split(path.sep).filter((p) => p.length > 0);
  const fileName = parts[parts.length - 1];
  for (const segment of parts) {
    if (AGENT_HIDDEN_NAMES.has(segment)) {
      return true;
    }
  }
  if (fileName && isSensitiveFileName(fileName)) {
    return true;
  }
  return false;
}

function isOutsideSensitive(absPath: string): boolean {
  const fileName = path.basename(absPath);
  return fileName.length > 0 && isSensitiveFileName(fileName);
}

export class WorkspaceFsPolicy {
  private readonly rootResolved: string;
  private readonly rootGitignore: ReturnType<typeof ignore>;
  private readonly outsideAccess = new OutsideAccessRegistry();

  constructor(root: string) {
    this.rootResolved = path.resolve(root);
    this.rootGitignore = ignore();
    const gitignorePath = path.join(this.rootResolved, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      try {
        this.rootGitignore.add(fs.readFileSync(gitignorePath, "utf-8"));
      } catch {
        // Keep the policy operational even when .gitignore is unreadable.
      }
    }
  }

  getRoot(): string {
    return this.rootResolved;
  }

  /** Grant outside-workspace access for a directory subtree (after user confirmation). */
  approveOutsideAccess(mode: Exclude<FsIntent, "inside">, dirPath: string): void {
    this.outsideAccess.approve(mode, dirPath);
  }

  /**
   * Whether root `.gitignore` rules exclude this path. Used for traversal filtering
   * (collectFiles / directory trees); no state-dir exemption, unlike {@link isPathHidden}.
   */
  isIgnoredByGitignore(workspaceRelative: string, isDirectory: boolean): boolean {
    const p = toGitignorePath(workspaceRelative);
    if (p.length === 0 || p === ".") {
      return false;
    }
    if (isDirectory) {
      return this.rootGitignore.ignores(p) || this.rootGitignore.ignores(`${p}/`);
    }
    return this.rootGitignore.ignores(p);
  }

  shouldSkipIgnoredWorkspaceEntry(parentRelativeDir: string, entry: WorkspaceDirEntry): boolean {
    const isDirectory = entry.isDirectory();
    if (isDirectory && TOOL_ALWAYS_IGNORED_DIR_NAMES.has(entry.name)) {
      return true;
    }
    return this.isIgnoredByGitignore(path.join(parentRelativeDir, entry.name), isDirectory);
  }

  shouldSkipResolvedEntry(parent: ResolvedFsPath, entry: WorkspaceDirEntry): boolean {
    if (parent.outside) {
      return entry.isDirectory() && TOOL_ALWAYS_IGNORED_DIR_NAMES.has(entry.name);
    }
    return this.shouldSkipIgnoredWorkspaceEntry(parent.rel, entry);
  }

  childResolved(parent: ResolvedFsPath, childName: string): ResolvedFsPath {
    return {
      abs: path.join(parent.abs, childName),
      rel: path.join(parent.rel, childName),
      displayPath: path.join(parent.displayPath, childName),
      outside: parent.outside,
    };
  }

  private isPathHidden(relativeNormalized: string): boolean {
    if (isPathSystemHidden(relativeNormalized)) {
      return true;
    }
    const gitignorePath = toGitignorePath(relativeNormalized);
    if (
      gitignorePath === EVIL_JELLY_STATE_DIR ||
      gitignorePath.startsWith(`${EVIL_JELLY_STATE_DIR}/`)
    ) {
      return false;
    }
    if (
      gitignorePath.length > 0 &&
      gitignorePath !== "." &&
      this.rootGitignore.ignores(gitignorePath)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Internal: resolve a path relative to root and enforce jail policy.
   */
  resolvePath(relativePath: string): string {
    const resolved = this.tryResolve(relativePath);
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    return resolved.abs;
  }

  /**
   * Same as resolvePath but returns a result type for tool handlers.
   */
  tryResolve(
    userPath: string,
    options: { intent?: FsIntent; approvalMode?: FsApprovalMode } = {},
  ): FsResolveResult {
    try {
      const intent = options.intent ?? "inside";
      const approvalMode = options.approvalMode ?? "normal";
      const abs = path.resolve(this.rootResolved, userPath);
      const rel = path.relative(this.rootResolved, abs);
      // Block path traversal and any escape outside workspace root.
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        const outsideRel = path.normalize(rel.length === 0 ? "." : rel);
        if (intent === "inside") {
          return {
            ok: false,
            error: "Access denied: Path traversal outside workspace root is not allowed.",
          };
        }
        if (isOutsideSensitive(abs)) {
          return {
            ok: false,
            error: sensitiveFileError(abs),
          };
        }
        if (intent === "read" && approvalMode === "auto") {
          return { ok: true, abs, rel: outsideRel, displayPath: abs, outside: true };
        }
        if (this.outsideAccess.has(intent, abs)) {
          return { ok: true, abs, rel: outsideRel, displayPath: abs, outside: true };
        }
        const approveDir = suggestOutsideApproveDir(abs);
        return {
          ok: false,
          error: `Access outside workspace requires approval: ${abs}`,
          needsApproval: true,
          mode: intent,
          targetPath: abs,
          approveDir,
        };
      }
      const relNorm = path.normalize(rel.length === 0 ? "." : rel);
      const fileName = path.basename(relNorm);
      if (fileName.length > 0 && isSensitiveFileName(fileName)) {
        return {
          ok: false,
          error: sensitiveFileError(relNorm),
        };
      }
      if (this.isPathHidden(relNorm)) {
        return {
          ok: false,
          error: `Access denied: Path '${relNorm}' is hidden or ignored.`,
        };
      }
      return { ok: true, abs, rel: relNorm, displayPath: relNorm, outside: false };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  async readFile(relativePath: string): Promise<string> {
    return fsPromises.readFile(this.resolvePath(relativePath), "utf-8");
  }

  async readResolved(resolved: ResolvedFsPath): Promise<string> {
    return fsPromises.readFile(resolved.abs, "utf-8");
  }

  async readAstFile(relativePath: string): Promise<string> {
    return this.readFile(relativePath);
  }

  /** Read a file as raw bytes (for binary assets such as images). */
  async readBinaryFile(relativePath: string): Promise<Buffer> {
    return fsPromises.readFile(this.resolvePath(relativePath));
  }

  async readResolvedBinary(resolved: ResolvedFsPath): Promise<Buffer> {
    return fsPromises.readFile(resolved.abs);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    await fsPromises.writeFile(this.resolvePath(relativePath), content, "utf-8");
  }

  async writeResolved(resolved: ResolvedFsPath, content: string): Promise<void> {
    await fsPromises.writeFile(resolved.abs, content, "utf-8");
  }

  async writeNewFile(relativePath: string, content: string): Promise<void> {
    await fsPromises.writeFile(this.resolvePath(relativePath), content, {
      encoding: "utf-8",
      flag: "wx",
    });
  }

  async writeNewResolved(resolved: ResolvedFsPath, content: string): Promise<void> {
    await fsPromises.writeFile(resolved.abs, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  }

  async stat(relativePath: string) {
    return fsPromises.stat(this.resolvePath(relativePath));
  }

  async statResolved(resolved: ResolvedFsPath) {
    return fsPromises.stat(resolved.abs);
  }

  async readdir(
    relativeDir: string,
    options: { withFileTypes: true },
  ): Promise<WorkspaceDirEntry[]> {
    const raw = await fsPromises.readdir(this.resolvePath(relativeDir), options);
    return raw.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDirectory(),
      isSymbolicLink: () => e.isSymbolicLink(),
    }));
  }

  async readdirResolved(
    resolved: ResolvedFsPath,
    options: { withFileTypes: true },
  ): Promise<WorkspaceDirEntry[]> {
    const raw = await fsPromises.readdir(resolved.abs, options);
    return raw.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDirectory(),
      isSymbolicLink: () => e.isSymbolicLink(),
    }));
  }

  /**
   * Deterministically walk workspace files without exposing raw filesystem traversal to domains.
   * The policy owns containment, ignored/hidden entries, symlink handling and traversal bounds;
   * callers own only semantic file selection.
   */
  async walkFiles(options: WorkspaceWalkFilesOptions): Promise<string[]> {
    const { maxFiles, includeFile = () => true } = options;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_WORKSPACE_WALK_ENTRIES;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) {
      throw new Error("maxFiles must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new Error("maxEntries must be a non-negative safe integer");
    }
    if (maxFiles === 0 || maxEntries === 0) {
      return [];
    }

    const files: string[] = [];
    const seenFiles = new Set<string>();
    const visitedDirectories = new Set<string>();
    let visitedEntries = 0;

    const considerFile = (resolved: ResolvedFsPath): void => {
      if (files.length >= maxFiles || path.basename(resolved.rel).startsWith(".")) {
        return;
      }
      if (this.isPathHidden(resolved.rel)) {
        return;
      }
      const relPosix = toGitignorePath(resolved.rel);
      if (seenFiles.has(relPosix) || !includeFile(relPosix)) {
        return;
      }
      seenFiles.add(relPosix);
      files.push(relPosix);
    };

    const visitDirectory = async (directory: ResolvedFsPath): Promise<void> => {
      if (
        files.length >= maxFiles ||
        visitedEntries >= maxEntries ||
        visitedDirectories.has(directory.rel)
      ) {
        return;
      }
      visitedDirectories.add(directory.rel);

      let entries: WorkspaceDirEntry[];
      try {
        entries = await this.readdirResolved(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const entry of entries) {
        if (files.length >= maxFiles || visitedEntries >= maxEntries) {
          return;
        }
        visitedEntries += 1;
        if (
          entry.name.startsWith(".") ||
          entry.isSymbolicLink?.() ||
          this.shouldSkipResolvedEntry(directory, entry)
        ) {
          continue;
        }
        const child = this.childResolved(directory, entry.name);
        if (this.isPathHidden(child.rel)) {
          continue;
        }
        if (entry.isDirectory()) {
          await visitDirectory(child);
        } else {
          considerFile(child);
        }
      }
    };

    const roots = [...new Set(options.roots ?? ["."])].sort();
    for (const root of roots) {
      if (files.length >= maxFiles || visitedEntries >= maxEntries) {
        break;
      }
      const resolved = this.tryResolve(root);
      if (
        !resolved.ok ||
        resolved.outside ||
        (resolved.rel !== "." && path.basename(resolved.rel).startsWith("."))
      ) {
        continue;
      }
      try {
        const rootStat = await fsPromises.lstat(resolved.abs);
        if (rootStat.isSymbolicLink()) {
          continue;
        }
        if (rootStat.isDirectory()) {
          await visitDirectory(resolved);
        } else if (rootStat.isFile()) {
          visitedEntries += 1;
          considerFile(resolved);
        }
      } catch {
        // Missing and unreadable roots behave like an empty traversal.
      }
    }
    return files;
  }

  async mkdir(relativeDir: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    return fsPromises.mkdir(this.resolvePath(relativeDir), options);
  }

  async mkdirResolved(
    resolved: ResolvedFsPath,
    options?: { recursive?: boolean },
  ): Promise<string | undefined> {
    return fsPromises.mkdir(resolved.abs, options);
  }

  async deleteEntry(relativePath: string): Promise<void> {
    const resolved = this.tryResolve(relativePath);
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    if (resolved.rel === ".") {
      throw new Error("Access denied: refusing to delete the workspace root.");
    }
    await fsPromises.rm(resolved.abs, { recursive: true, force: false });
  }

  async pruneEmptyParentsInside(startRelativeDir: string): Promise<string[]> {
    const removed: string[] = [];
    let current = this.resolvePath(startRelativeDir);

    while (current !== this.rootResolved) {
      const relToRoot = path.relative(this.rootResolved, current);
      if (relToRoot.length === 0 || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        break;
      }

      const relNorm = path.normalize(relToRoot);
      const currentAbs = this.resolvePath(relNorm);

      try {
        const entries = await fsPromises.readdir(currentAbs);
        if (entries.length > 0) {
          break;
        }
        await fsPromises.rmdir(currentAbs);
        removed.push(relNorm);
        current = path.dirname(currentAbs);
      } catch (e: unknown) {
        const code = getErrnoCode(e);
        if (code === "ENOENT") {
          current = path.dirname(currentAbs);
          continue;
        }
        if (code === "ENOTEMPTY") {
          break;
        }
        break;
      }
    }

    return removed;
  }
}

let workspaceImpl: WorkspaceFsPolicy | undefined;

export function getWorkspaceFsPolicy(): WorkspaceFsPolicy {
  workspaceImpl ??= new WorkspaceFsPolicy(process.cwd());
  return workspaceImpl;
}

/**
 * Resolve a workspace-relative cwd into an absolute path.
 * Defaults to workspace root when cwd is missing.
 */
export function resolveWorkspaceCwd(workspaceRoot: string, cwd?: string): string {
  if (!cwd || cwd.trim().length === 0) {
    return workspaceRoot;
  }
  const resolvedCwd = path.resolve(workspaceRoot, cwd);
  if (!isPathInside(workspaceRoot, resolvedCwd)) {
    throw new Error(`cwd must stay inside workspace root: ${workspaceRoot}`);
  }
  return resolvedCwd;
}

/**
 * Replace workspace root (absolute path). All per-workspace state (gitignore rules,
 * outside-access approvals) lives on the instance, so the swap resets everything at once.
 */
export function setWorkspaceRoot(root: string): void {
  workspaceImpl = new WorkspaceFsPolicy(path.resolve(root));
}
