import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MemoryProjectIdentity =
  | {
      readonly kind: "git";
      readonly canonicalIdentity: string;
      readonly repositoryRoot: string;
      readonly projectName: string;
    }
  | {
      readonly kind: "workspace";
      readonly canonicalIdentity: string;
      readonly repositoryRoot: undefined;
      readonly projectName: string;
    };

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function comparisonPath(filePath: string): string {
  const canonical = canonicalPath(filePath);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function sanitizedProjectName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "_");
  return sanitized || "workspace";
}

function projectNameFromCommonDirectory(commonDirectory: string): string {
  const commonName = path.basename(commonDirectory);
  if (commonName === ".git") {
    return path.basename(path.dirname(commonDirectory));
  }
  return commonName.endsWith(".git") ? commonName.slice(0, -4) : commonName;
}

function gitDirectoryFromMarker(markerPath: string, workspaceRoot: string): string | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(markerPath);
  } catch {
    return undefined;
  }

  if (stats.isDirectory()) return canonicalPath(markerPath);
  if (!stats.isFile()) return undefined;

  let marker: string;
  try {
    marker = fs.readFileSync(markerPath, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(marker);
  if (!match) return undefined;
  return canonicalPath(path.resolve(workspaceRoot, match[1]!));
}

function commonGitDirectory(gitDirectory: string): string {
  const commondirPath = path.join(gitDirectory, "commondir");
  try {
    const relativeCommonDirectory = fs.readFileSync(commondirPath, "utf8").trim();
    if (relativeCommonDirectory) {
      return canonicalPath(path.resolve(gitDirectory, relativeCommonDirectory));
    }
  } catch {
    // A normal repository has no commondir file; its .git directory is the identity.
  }
  return canonicalPath(gitDirectory);
}

function findGitMarker(
  workspaceRoot: string,
): { markerPath: string; repositoryRoot: string } | undefined {
  let current = workspaceRoot;
  for (;;) {
    const markerPath = path.join(current, ".git");
    if (gitDirectoryFromMarker(markerPath, current)) {
      return { markerPath, repositoryRoot: current };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Resolve the stable scope key used by project persistent memory. */
export function resolveMemoryProjectIdentity(workspaceRoot: string): MemoryProjectIdentity {
  const resolvedWorkspace = canonicalPath(path.resolve(workspaceRoot));
  const gitMarker = findGitMarker(resolvedWorkspace);
  if (!gitMarker) {
    return {
      kind: "workspace",
      canonicalIdentity: comparisonPath(resolvedWorkspace),
      repositoryRoot: undefined,
      projectName: sanitizedProjectName(path.basename(resolvedWorkspace)),
    };
  }

  const gitDirectory = gitDirectoryFromMarker(gitMarker.markerPath, gitMarker.repositoryRoot);
  if (!gitDirectory) {
    return {
      kind: "workspace",
      canonicalIdentity: comparisonPath(resolvedWorkspace),
      repositoryRoot: undefined,
      projectName: sanitizedProjectName(path.basename(resolvedWorkspace)),
    };
  }

  const repositoryRoot = canonicalPath(gitMarker.repositoryRoot);
  const commonDirectory = commonGitDirectory(gitDirectory);
  return {
    kind: "git",
    canonicalIdentity: comparisonPath(commonDirectory),
    repositoryRoot,
    // Derive the display name from the shared Git directory so main checkouts
    // and linked worktrees use the same bucket base.
    projectName: sanitizedProjectName(projectNameFromCommonDirectory(commonDirectory)),
  };
}

/**
 * Project bucket naming matches session buckets, but its identity input does
 * not: memory is shared by a repository while sessions remain workspace-local.
 */
export function memoryProjectBucket(identity: MemoryProjectIdentity): string {
  const digest = crypto
    .createHash("sha1")
    .update(`${identity.kind}\0${identity.canonicalIdentity}`)
    .digest("hex")
    .slice(0, 8);
  return `${identity.projectName}-${digest}`;
}
