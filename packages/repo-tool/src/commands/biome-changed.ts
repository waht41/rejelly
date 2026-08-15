import { existsSync } from "node:fs";
import path from "node:path";
import { collectChangedPaths } from "../lib/changes.js";
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
  const changed = collectChangedPaths(repoRoot, requestedBase);
  const resolvedRoot = path.resolve(repoRoot);
  const files = changed.files.filter((file) => existsSync(path.join(resolvedRoot, file))).sort();
  return { base: changed.base, files };
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
