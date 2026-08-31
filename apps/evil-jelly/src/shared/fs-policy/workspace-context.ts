import path from "node:path";
import { isPathInside } from "./path-containment";

export const EVIL_JELLY_STATE_DIR = ".evil-jelly";
export const AGENT_SCRATCH_DIR = `${EVIL_JELLY_STATE_DIR}/tmp`;

let workspaceRoot = path.resolve(process.cwd());

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function setWorkspaceRoot(root: string): void {
  workspaceRoot = path.resolve(root);
}

/** Resolve a workspace-relative cwd and refuse escapes. Used by workspace-scoped subprocesses. */
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
