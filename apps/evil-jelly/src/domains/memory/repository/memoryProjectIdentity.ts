import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGlobalJellyDir } from "../../../shared/globalPath";
import { isHomeWorkspace } from "../../../shared/workspaceScope";
import {
  canonicalProjectPath,
  findRegisteredProject,
  getOrCreateRegisteredProject,
  listRegisteredProjects,
  type MemoryProjectKind,
  type MemoryProjectRecord,
  migrateLegacyProjectRegistry,
} from "./memoryProjectRegistry";

export interface MemoryProjectIdentity {
  readonly projectId: string;
  readonly root: string;
  readonly createdAt: string;
  readonly projectName: string;
  readonly kind: MemoryProjectKind;
}

function sanitizedProjectName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "_");
  return sanitized || "workspace";
}

function gitDirectoryFromMarker(markerPath: string, workspaceRoot: string): string | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(markerPath);
  } catch {
    return undefined;
  }

  if (stats.isDirectory()) return canonicalProjectPath(markerPath);
  if (!stats.isFile()) return undefined;

  let marker: string;
  try {
    marker = fs.readFileSync(markerPath, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(marker);
  if (!match) return undefined;
  return canonicalProjectPath(path.resolve(workspaceRoot, match[1]!));
}

function commonGitDirectory(gitDirectory: string): string {
  const commondirPath = path.join(gitDirectory, "commondir");
  try {
    const relativeCommonDirectory = fs.readFileSync(commondirPath, "utf8").trim();
    if (relativeCommonDirectory) {
      return canonicalProjectPath(path.resolve(gitDirectory, relativeCommonDirectory));
    }
  } catch {
    // A normal repository has no commondir file; its .git directory is the identity.
  }
  return canonicalProjectPath(gitDirectory);
}

function findGitProjectRoot(workspaceRoot: string): string | undefined {
  const commonDirectory = findGitCommonDirectory(workspaceRoot);
  if (!commonDirectory) return undefined;
  return path.basename(commonDirectory) === ".git"
    ? path.dirname(commonDirectory)
    : commonDirectory;
}

function findGitCommonDirectory(workspaceRoot: string): string | undefined {
  let current = workspaceRoot;
  for (;;) {
    const markerPath = path.join(current, ".git");
    const gitDirectory = gitDirectoryFromMarker(markerPath, current);
    if (gitDirectory) return commonGitDirectory(gitDirectory);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function identityFromRecord(record: MemoryProjectRecord): MemoryProjectIdentity {
  return {
    projectId: record.projectId,
    root: record.root,
    createdAt: record.createdAt,
    projectName: record.kind === "home" ? "home" : sanitizedProjectName(path.basename(record.root)),
    kind: record.kind,
  };
}

/**
 * Resolve a local project identity.
 *
 * Registered project boundaries are sticky and nearest-ancestor wins. Git is
 * consulted only when no registered project contains the workspace; it never
 * contributes to the project ID and never merges existing projects.
 */
export function resolveMemoryProjectIdentity(
  workspaceRoot: string,
  memoryRoot = path.join(resolveGlobalJellyDir(), "memory"),
): MemoryProjectIdentity {
  const resolvedWorkspace = canonicalProjectPath(workspaceRoot);
  const homeRoot = canonicalProjectPath(os.homedir());
  migrateLegacyProjectRegistry(memoryRoot, homeRoot);
  const registered = findRegisteredProject(resolvedWorkspace, memoryRoot, homeRoot);
  if (registered) return identityFromRecord(registered);

  const currentCommonDirectory = findGitCommonDirectory(resolvedWorkspace);
  if (currentCommonDirectory) {
    const associated = listRegisteredProjects(memoryRoot, homeRoot).find((project) => {
      if (project.kind === "home") return false;
      const projectCommonDirectory = findGitCommonDirectory(project.root);
      return projectCommonDirectory === currentCommonDirectory;
    });
    if (associated) return identityFromRecord(associated);
  }

  const projectRoot = findGitProjectRoot(resolvedWorkspace) ?? resolvedWorkspace;
  const kind: MemoryProjectKind = isHomeWorkspace(projectRoot, homeRoot) ? "home" : "standard";
  return identityFromRecord(getOrCreateRegisteredProject(projectRoot, memoryRoot, kind, homeRoot));
}
