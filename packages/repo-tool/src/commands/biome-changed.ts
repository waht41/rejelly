import { existsSync } from "node:fs";
import path from "node:path";
import { createGit, resolveBase } from "../lib/git.js";
import { run } from "../lib/process.js";

export interface BiomeChangedOptions {
  allowMany: boolean;
  base?: string;
  maxFiles: number;
  write: boolean;
}

export function collectBiomeChangedFiles(
  repoRoot: string,
  requestedBase?: string,
): {
  base: string;
  files: string[];
} {
  const git = createGit(repoRoot);
  const base = resolveBase(git, requestedBase);
  const mergeBase = git.text(["merge-base", "HEAD", base]);
  const candidates = new Set([
    ...git.nul(["diff", "--name-only", "--diff-filter=ACMRT", mergeBase, "HEAD"]),
    ...git.nul(["diff", "--name-only", "--diff-filter=ACMRT"]),
    ...git.nul(["diff", "--cached", "--name-only", "--diff-filter=ACMRT"]),
    ...git.nul(["ls-files", "--others", "--exclude-standard"]),
  ]);
  const resolvedRoot = path.resolve(repoRoot);
  const files = [...candidates]
    .filter((file) => existsSync(path.join(resolvedRoot, file)))
    .map((file) => {
      const absolute = path.resolve(resolvedRoot, file);
      const relative = path.relative(resolvedRoot, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Refusing out-of-workspace path: ${file}`);
      }
      return relative;
    })
    .sort();
  return { base, files };
}

export function runBiomeChanged(repoRoot: string, options: BiomeChangedOptions): number {
  const { base, files } = collectBiomeChangedFiles(repoRoot, options.base);
  console.log(
    `Biome ${options.write ? "write" : "check"}: ${files.length} changed candidate(s), base ${base}`,
  );
  for (const file of files) console.log(`  ${file}`);
  if (files.length === 0) return 0;
  if (!options.allowMany && files.length > options.maxFiles) {
    throw new Error(
      `Refusing to process ${files.length} files (limit ${options.maxFiles}); inspect the scope or pass --allow-many`,
    );
  }
  return run(
    "pnpm",
    [
      "exec",
      "biome",
      "check",
      "--no-errors-on-unmatched",
      ...(options.write ? ["--write"] : []),
      ...files,
    ],
    repoRoot,
  );
}
