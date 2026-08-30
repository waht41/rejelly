import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGlobalJellyDir } from "./globalPath";

function canonicalPath(filePath: string): string {
  let existing = path.resolve(filePath);
  const missingSegments: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    existing = fs.realpathSync.native(existing);
  } catch {
    existing = path.resolve(existing);
  }

  const canonical = path.normalize(path.join(existing, ...missingSegments));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Compare filesystem locations through existing-parent realpaths and platform case rules. */
export function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export interface WorkspaceScopePaths {
  readonly workspaceRoot: string;
  readonly globalJellyDir: string;
  readonly workspaceJellyDir: string;
  /** False when the workspace `.evil-jelly` directory is the user-global directory. */
  readonly hasDistinctProjectState: boolean;
}

/** Resolve user/project state roots once without allowing one directory to represent both scopes. */
export function resolveWorkspaceScopePaths(
  workspaceRoot: string,
  globalJellyDir = resolveGlobalJellyDir(),
): WorkspaceScopePaths {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedGlobal = path.resolve(globalJellyDir);
  const workspaceJellyDir = path.join(resolvedWorkspace, ".evil-jelly");
  return Object.freeze({
    workspaceRoot: resolvedWorkspace,
    globalJellyDir: resolvedGlobal,
    workspaceJellyDir,
    hasDistinctProjectState: !sameCanonicalPath(workspaceJellyDir, resolvedGlobal),
  });
}

/** Home is a special exact-match memory project, never an ancestor project boundary. */
export function isHomeWorkspace(workspaceRoot: string, homeDir = os.homedir()): boolean {
  return sameCanonicalPath(workspaceRoot, homeDir);
}
