import path from "node:path";
import { createGit, resolveBase } from "./git.js";

export interface ChangedPaths {
  base: string;
  files: string[];
  mergeBase: string;
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
  const files = [
    ...new Set([
      ...git.nul(["diff", "--name-only", "--diff-filter=ACDMRT", mergeBase, "HEAD"]),
      ...git.nul(["diff", "--name-only", "--diff-filter=ACDMRT"]),
      ...git.nul(["diff", "--cached", "--name-only", "--diff-filter=ACDMRT"]),
      ...git.nul(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ]
    .map((file) => workspaceRelativePath(repoRoot, file))
    .sort();
  return { base, files, mergeBase };
}
