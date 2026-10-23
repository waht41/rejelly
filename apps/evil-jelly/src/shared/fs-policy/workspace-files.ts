/**
 * Project filesystem access for the repository and its system-temp workspace: shared protection,
 * bounded traversal, and filesystem I/O. Absolute locators remain distinct from access permissions.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { getErrnoCode } from "../foundation/errno";
import { isPathInside, isRealPathInside } from "./path-containment";
import { getProjectTempRoot, getWorkspaceRoot } from "./workspace-context";
import {
  isSensitiveFileName,
  type ScanPath,
  sensitiveFsPathError,
  toGitignorePath,
  type WorkspaceAccessKind,
  type WorkspaceDirEntry,
  WorkspaceScan,
} from "./workspace-scan";

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

export type FileAccess =
  | { kind: "read" }
  | { kind: "scan"; includeIgnored?: boolean }
  | { kind: "write" };

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
    };

const DEFAULT_SCAN_ACCESS: FileAccess = { kind: "scan" };

function toFsAccessKind(access: FileAccess): WorkspaceAccessKind {
  if (access.kind === "read") {
    return "direct-read";
  }
  if (access.kind === "write") {
    return "direct-write";
  }
  return access.includeIgnored ? "scoped-discovery" : "discovery";
}

const DEPENDENCY_DIR_NAME = "node_modules";
const DEFAULT_MAX_WORKSPACE_WALK_ENTRIES = 100_000;

export class WorkspaceFiles {
  private readonly rootResolved: string;
  private readonly scan: WorkspaceScan;
  private readonly tempRoot: string;
  private tempScan: WorkspaceScan | undefined;

  constructor(root: string) {
    this.rootResolved = path.resolve(root);
    this.tempRoot = getProjectTempRoot(this.rootResolved);
    this.scan = new WorkspaceScan(this.rootResolved);
  }

  getRoot(): string {
    return this.rootResolved;
  }

  /** Managed roots share access rules; `outside` still describes absolute-path presentation. */
  isManagedPath(userPath: string): boolean {
    const absolute = path.resolve(this.rootResolved, userPath);
    return isPathInside(this.rootResolved, absolute) || isPathInside(this.tempRoot, absolute);
  }

  isRoot(absolute: string): boolean {
    return (
      path.relative(this.rootResolved, absolute) === "" ||
      path.relative(this.tempRoot, absolute) === ""
    );
  }

  private getTempScan(): WorkspaceScan {
    this.tempScan ??= new WorkspaceScan(this.tempRoot);
    return this.tempScan;
  }

  private scanFor(resolved: ResolvedFsPath): { scan: WorkspaceScan; scanPath: ScanPath } {
    if (resolved.outside && isPathInside(this.tempRoot, resolved.abs)) {
      return {
        scan: this.getTempScan(),
        scanPath: { rel: path.relative(this.tempRoot, resolved.abs) || ".", outside: false },
      };
    }
    return { scan: this.scan, scanPath: resolved };
  }

  /**
   * Whether root `.gitignore` rules exclude this path. Used for traversal filtering
   * (collectFiles / directory trees); no state-dir exemption, unlike {@link isPathHidden}.
   */
  isIgnoredByGitignore(workspaceRelative: string, isDirectory: boolean): boolean {
    return this.scan.isIgnoredByGitignore(workspaceRelative, isDirectory);
  }

  shouldSkipIgnoredWorkspaceEntry(parentRelativeDir: string, entry: WorkspaceDirEntry): boolean {
    return this.scan.shouldSkipIgnoredWorkspaceEntry(parentRelativeDir, entry);
  }

  shouldSkipResolvedEntry(parent: ResolvedFsPath, entry: WorkspaceDirEntry): boolean {
    const { scan, scanPath } = this.scanFor(parent);
    return scan.shouldSkipResolvedEntry(scanPath, entry);
  }

  /**
   * Traversal guard after an ignored subtree was explicitly selected. Root `.gitignore` rules no
   * longer hide its children, but nested bulky/tool directories, sensitive files, and symlinks
   * remain excluded by default. Bounded callers may traverse dependency/build directories and
   * show link names, but must never follow discovered links. Nested Git/agent metadata stays hidden.
   */
  shouldSkipScopedResolvedEntry(
    parent: ResolvedFsPath,
    entry: WorkspaceDirEntry,
    boundedTraversal = false,
  ): boolean {
    const { scan, scanPath } = this.scanFor(parent);
    return scan.shouldSkipScopedResolvedEntry(scanPath, entry, boundedTraversal);
  }

  /** Shallow listings can enumerate dependencies; recursive discovery still requires a package. */
  validateScopedDiscoveryRoot(
    resolved: ResolvedFsPath,
    shallowListing = false,
  ): string | undefined {
    const { scan, scanPath } = this.scanFor(resolved);
    return scan.validateScopedDiscoveryRoot(scanPath, shallowListing);
  }

  childResolved(parent: ResolvedFsPath, childName: string): ResolvedFsPath {
    return {
      abs: path.join(parent.abs, childName),
      rel: path.join(parent.rel, childName),
      displayPath: path.join(parent.displayPath, childName),
      outside: parent.outside,
    };
  }

  classifyPath(userPath: string): ResolvedFsPath {
    const abs = path.resolve(this.rootResolved, userPath);
    const rel = path.relative(this.rootResolved, abs);
    const outside = rel.startsWith("..") || path.isAbsolute(rel);
    const relNorm = path.normalize(rel.length === 0 ? "." : rel);
    return {
      abs,
      rel: relNorm,
      displayPath: outside ? abs : relNorm,
      outside,
    };
  }

  suggestContainingDirectory(targetPath: string): string {
    const abs = path.resolve(targetPath);
    try {
      return fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      return path.dirname(abs);
    }
  }

  resolveWorkspacePath(userPath: string, access: FileAccess = DEFAULT_SCAN_ACCESS): string {
    const resolved = this.tryResolveWorkspacePath(userPath, access);
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    return resolved.abs;
  }

  tryResolveWorkspacePath(
    userPath: string,
    access: FileAccess = DEFAULT_SCAN_ACCESS,
  ): FsResolveResult {
    return this.tryResolvePath(userPath, access);
  }

  private tryResolvePath(userPath: string, fileAccess: FileAccess): FsResolveResult {
    try {
      const resolved = this.classifyPath(userPath);
      const access = toFsAccessKind(fileAccess);
      const temporary = resolved.outside && isPathInside(this.tempRoot, resolved.abs);
      if (resolved.outside && !temporary) {
        return {
          ok: false,
          error: "Access denied: Path traversal outside workspace root is not allowed.",
        };
      }
      if (temporary && !isRealPathInside(this.tempRoot, resolved.abs)) {
        return {
          ok: false,
          error: "Access denied: Path resolves outside the project temp workspace.",
        };
      }
      const scanRoot = temporary ? this.tempRoot : this.rootResolved;
      const scan = temporary ? this.getTempScan() : this.scan;
      const relative = path.relative(scanRoot, resolved.abs) || ".";
      const fileName = path.basename(relative);
      if (fileName.length > 0 && isSensitiveFileName(fileName)) {
        return {
          ok: false,
          error: sensitiveFsPathError(resolved.rel),
        };
      }
      if (scan.isPathHidden(relative, access)) {
        return {
          ok: false,
          error:
            access === "direct-write"
              ? `Access denied: Path '${resolved.rel}' is read-only; .git metadata and node_modules dependencies cannot be modified.`
              : `Access denied: Path '${resolved.rel}' is hidden or ignored during default discovery. Use an explicit subdirectory with includeIgnored: true, or read an exact file path.`,
        };
      }
      if (
        (access === "direct-read" || access === "scoped-discovery") &&
        relative.split(path.sep).includes(DEPENDENCY_DIR_NAME) &&
        fs.existsSync(resolved.abs)
      ) {
        const rootRealPath = fs.realpathSync.native(scanRoot);
        const realPath = fs.realpathSync.native(resolved.abs);
        if (!isPathInside(rootRealPath, realPath)) {
          return {
            ok: false,
            error: `Access denied: Dependency path '${resolved.rel}' resolves outside the workspace.`,
          };
        }
      }
      return { ok: true, ...resolved };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  async readFile(relativePath: string): Promise<string> {
    return fsPromises.readFile(this.resolveWorkspacePath(relativePath, { kind: "read" }), "utf-8");
  }

  async readResolved(resolved: ResolvedFsPath): Promise<string> {
    return fsPromises.readFile(resolved.abs, "utf-8");
  }

  /** Stream a bounded text source for explicit-file grep without loading the whole file. */
  async *readResolvedLines(resolved: ResolvedFsPath, maxBytes: number): AsyncGenerator<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("maxBytes must be a positive safe integer");
    }
    const stream = fs.createReadStream(resolved.abs, {
      encoding: "utf8",
      start: 0,
      end: maxBytes - 1,
    });
    let pending = "";
    try {
      for await (const chunk of stream) {
        pending += chunk;
        let start = 0;
        let newline = pending.indexOf("\n", start);
        while (newline >= 0) {
          yield pending.slice(start, newline).replace(/\r$/, "");
          start = newline + 1;
          newline = pending.indexOf("\n", start);
        }
        pending = pending.slice(start);
      }
      if (pending) yield pending.replace(/\r$/, "");
    } finally {
      stream.destroy();
    }
  }

  async readAstFile(relativePath: string): Promise<string> {
    return this.readFile(relativePath);
  }

  /** Read a file as raw bytes (for binary assets such as images). */
  async readBinaryFile(relativePath: string): Promise<Buffer> {
    return fsPromises.readFile(this.resolveWorkspacePath(relativePath, { kind: "read" }));
  }

  async readResolvedBinary(resolved: ResolvedFsPath): Promise<Buffer> {
    return fsPromises.readFile(resolved.abs);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    await fsPromises.writeFile(
      this.resolveWorkspacePath(relativePath, { kind: "write" }),
      content,
      "utf-8",
    );
  }

  async writeResolved(resolved: ResolvedFsPath, content: string): Promise<void> {
    await fsPromises.writeFile(resolved.abs, content, "utf-8");
  }

  async writeNewFile(relativePath: string, content: string): Promise<void> {
    await fsPromises.writeFile(
      this.resolveWorkspacePath(relativePath, { kind: "write" }),
      content,
      {
        encoding: "utf-8",
        flag: "wx",
      },
    );
  }

  async writeNewResolved(resolved: ResolvedFsPath, content: string): Promise<void> {
    await fsPromises.writeFile(resolved.abs, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  }

  async stat(relativePath: string, access: FileAccess = DEFAULT_SCAN_ACCESS) {
    return fsPromises.stat(this.resolveWorkspacePath(relativePath, access));
  }

  async statResolved(resolved: ResolvedFsPath) {
    return fsPromises.stat(resolved.abs);
  }

  async readdir(
    relativeDir: string,
    options: { withFileTypes: true },
  ): Promise<WorkspaceDirEntry[]> {
    const raw = await fsPromises.readdir(this.resolveWorkspacePath(relativeDir), options);
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

  /** Stream directory entries so bounded consumers can stop without loading the whole directory. */
  async *iterateDirectoryResolved(resolved: ResolvedFsPath): AsyncGenerator<WorkspaceDirEntry> {
    const directory = await fsPromises.opendir(resolved.abs, { bufferSize: 1 });
    for await (const entry of directory) {
      yield entry;
    }
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
      if (this.scan.isPathHidden(resolved.rel, "discovery")) {
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
        if (this.scan.isPathHidden(child.rel, "discovery")) {
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
      const resolved = this.tryResolveWorkspacePath(root);
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
    return fsPromises.mkdir(this.resolveWorkspacePath(relativeDir, { kind: "write" }), options);
  }

  async mkdirResolved(
    resolved: ResolvedFsPath,
    options?: { recursive?: boolean },
  ): Promise<string | undefined> {
    return fsPromises.mkdir(resolved.abs, options);
  }

  async deleteEntry(relativePath: string): Promise<void> {
    const resolved = this.tryResolveWorkspacePath(relativePath, { kind: "write" });
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    await this.deleteResolved(resolved);
  }

  async deleteResolved(resolved: ResolvedFsPath): Promise<void> {
    if (this.isRoot(resolved.abs)) {
      throw new Error("Access denied: refusing to delete a workspace root.");
    }
    if (path.parse(resolved.abs).root === resolved.abs) {
      throw new Error("Access denied: refusing to delete a filesystem root.");
    }
    await fsPromises.rm(resolved.abs, { recursive: true, force: false });
  }

  async pruneEmptyParentsInside(startRelativeDir: string): Promise<string[]> {
    const removed: string[] = [];
    let current = this.resolveWorkspacePath(startRelativeDir, { kind: "write" });

    while (current !== this.rootResolved) {
      const relToRoot = path.relative(this.rootResolved, current);
      if (relToRoot.length === 0 || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        break;
      }

      const relNorm = path.normalize(relToRoot);
      const currentAbs = this.resolveWorkspacePath(relNorm, { kind: "write" });

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

let workspaceFiles: WorkspaceFiles | undefined;

export function getWorkspaceFiles(): WorkspaceFiles {
  const root = getWorkspaceRoot();
  if (!workspaceFiles || workspaceFiles.getRoot() !== root) {
    workspaceFiles = new WorkspaceFiles(root);
  }
  return workspaceFiles;
}
