import path from "node:path";
import { createGit, resolveBase } from "./git.js";

export interface ChangedPaths {
  base: string;
  branchFiles: string[];
  files: string[];
  mergeBase: string;
  workingTreeFiles: string[];
}

/** Parse `git diff --name-status -z`, retaining both sides of cross-package renames/copies. */
export function parseNameStatusPaths(records: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < records.length; ) {
    const status = records[index++] ?? "";
    const source = records[index++];
    if (!source) break;
    paths.push(source);
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = records[index++];
      if (destination) paths.push(destination);
    }
  }
  return paths;
}

function workspaceRelativePath(repoRoot: string, file: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const absolute = path.resolve(resolvedRoot, file);
  const relative = path.relative(resolvedRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing out-of-workspace path: ${file}`);
  }
  return relative;
}

export function collectChangedPaths(repoRoot: string, requestedBase?: string): ChangedPaths {
  const git = createGit(repoRoot);
  const base = resolveBase(git, requestedBase);
  const mergeBase = git.text(["merge-base", "HEAD", base]);
  const normalize = (files: readonly string[]) =>
    [...new Set(files.map((file) => workspaceRelativePath(repoRoot, file)))].sort();
  const branchFiles = normalize(
    parseNameStatusPaths(
      git.nul(["diff", "--name-status", "--diff-filter=ACDMRT", mergeBase, "HEAD"]),
    ),
  );
  const workingTreeFiles = normalize([
    ...parseNameStatusPaths(git.nul(["diff", "--name-status", "--diff-filter=ACDMRT"])),
    ...parseNameStatusPaths(git.nul(["diff", "--cached", "--name-status", "--diff-filter=ACDMRT"])),
    ...git.nul(["ls-files", "--others", "--exclude-standard"]),
  ]);
  return {
    base,
    branchFiles,
    files: normalize([...branchFiles, ...workingTreeFiles]),
    mergeBase,
    workingTreeFiles,
  };
}
