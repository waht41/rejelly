/** Project-scoped disposable tool snapshots. Never grants access to the surrounding system temp. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getErrnoCode } from "../foundation/errno";
import { workspaceBucket } from "../workspaceBucket";
import { isPathInside } from "./path-containment";
import { getWorkspaceRoot } from "./workspace-context";

export const MAX_TOOL_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_TOOL_ARTIFACT_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_TOOL_ARTIFACT_FILES = 64;
export const TOOL_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

type Artifact = { root: string; bytes: number; createdAt: number };

function assertSafeRoot(root: string): void {
  const applicationStat = fs.lstatSync(path.dirname(root));
  const rootStat = fs.lstatSync(root);
  if (
    applicationStat.isSymbolicLink() ||
    rootStat.isSymbolicLink() ||
    !applicationStat.isDirectory() ||
    !rootStat.isDirectory()
  ) {
    throw new Error("Tool snapshot directory was replaced by a link or non-directory.");
  }
  const realRoot = fs.realpathSync.native(root);
  if (!isPathInside(root, realRoot) || !isPathInside(realRoot, root)) {
    throw new Error("Tool snapshot directory was moved.");
  }
}

export class ToolArtifactStore {
  private readonly roots = new Map<string, string>();
  private readonly artifacts = new Map<string, Artifact>();
  private totalBytes = 0;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspaceRoot?: string) {}

  /** Capture the project before awaiting; concurrent fetches cannot overcommit the disk budget. */
  saveText(content: string, query = "page"): Promise<string> {
    const workspace = path.resolve(this.workspaceRoot ?? getWorkspaceRoot());
    const result = this.pending.then(() => this.save(content, query, workspace));
    this.pending = result.catch(() => {});
    return result;
  }

  private async ensureRoot(workspace: string): Promise<string> {
    const temp = await fsPromises.realpath(os.tmpdir());
    const application = path.join(temp, "evil-jelly");
    await fsPromises.mkdir(application, { recursive: true, mode: 0o700 });
    if ((await fsPromises.lstat(application)).isSymbolicLink()) {
      throw new Error("Tool snapshot application directory must not be a link.");
    }
    const root = path.join(application, workspaceBucket(workspace));
    await fsPromises.mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
      if (getErrnoCode(error) !== "EEXIST") throw error;
    });
    assertSafeRoot(root);
    this.roots.set(workspace, root);
    return root;
  }

  private async save(content: string, query: string, workspace: string): Promise<string> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_TOOL_ARTIFACT_BYTES) {
      throw new Error(`Tool snapshot exceeds the ${MAX_TOOL_ARTIFACT_BYTES}-byte file limit.`);
    }
    this.pruneExpired();
    while (
      this.artifacts.size >= MAX_TOOL_ARTIFACT_FILES ||
      this.totalBytes + bytes > MAX_TOOL_ARTIFACT_TOTAL_BYTES
    ) {
      const oldest = this.artifacts.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
    const root = await this.ensureRoot(workspace);
    const stem =
      query
        .normalize("NFKC")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "")
        .slice(0, 48) || "page";
    const file = path.join(root, `${stem}-${randomUUID()}.md`);
    const handle = await fsPromises.open(file, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await fsPromises.unlink(file).catch(() => {});
      throw error;
    }
    this.artifacts.set(file, { root, bytes, createdAt: Date.now() });
    this.totalBytes += bytes;
    return file;
  }

  /** Only the registered current project's root; no grants to sibling projects or system temp. */
  canRead(targetPath: string, workspaceRoot = this.workspaceRoot ?? getWorkspaceRoot()): boolean {
    const workspace = path.resolve(workspaceRoot);
    const root = this.roots.get(workspace);
    if (!root || !isPathInside(root, targetPath)) return false;
    try {
      this.pruneExpired();
      assertSafeRoot(root);
      let candidate = path.resolve(targetPath);
      while (isPathInside(root, candidate)) {
        try {
          return isPathInside(root, fs.realpathSync.native(candidate));
        } catch (error) {
          if (getErrnoCode(error) !== "ENOENT") return false;
          // Let file tools report ENOENT for evicted/expired artifacts, without asking approval.
          candidate = path.dirname(candidate);
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private pruneExpired(): void {
    for (const [file, artifact] of this.artifacts) {
      if (Date.now() - artifact.createdAt >= TOOL_ARTIFACT_TTL_MS) this.remove(file);
    }
  }

  private remove(file: string): void {
    const artifact = this.artifacts.get(file);
    if (!artifact) return;
    // Delete only this instance's files, never another session's files or a recursive subtree.
    try {
      assertSafeRoot(artifact.root);
      fs.unlinkSync(file);
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") throw error;
    }
    this.artifacts.delete(file);
    this.totalBytes -= artifact.bytes;
  }

  /** Best-effort normal-exit cleanup; other processes may share the stable project directory. */
  dispose(): void {
    for (const file of this.artifacts.keys()) {
      try {
        this.remove(file);
      } catch {
        // Keep failed deletions accounted for; never broaden cleanup to the parent temp directory.
      }
    }
    for (const [workspace, root] of this.roots) {
      try {
        assertSafeRoot(root);
        fs.rmdirSync(root);
        this.roots.delete(workspace);
      } catch (error) {
        if (getErrnoCode(error) === "ENOENT") this.roots.delete(workspace);
        // Leave nonempty/replaced directories, including other sessions' files, alone.
      }
    }
  }
}

export const toolArtifacts = new ToolArtifactStore();
process.once("exit", () => toolArtifacts.dispose());
