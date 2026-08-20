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

const BIOME_PATH_ARGUMENT_BUDGET = 6_000;

/** Keep pnpm/Biome invocations below the Windows command-line limit without changing file scope. */
export function chunkBiomePaths(
  files: readonly string[],
  argumentBudget = BIOME_PATH_ARGUMENT_BUDGET,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const file of files) {
    const argumentLength = file.length + 3;
    if (current.length > 0 && currentLength + argumentLength > argumentBudget) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(file);
    currentLength += argumentLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
  const batches = chunkBiomePaths(files);
  for (const [index, batch] of batches.entries()) {
    if (batches.length > 1) console.log(`Biome batch ${index + 1}/${batches.length}`);
    const status = run(
      "pnpm",
      [
        "exec",
        "biome",
        "check",
        "--no-errors-on-unmatched",
        ...(options.write ? ["--write"] : []),
        ...batch,
      ],
      repoRoot,
    );
    if (status !== 0) return status;
  }
  return 0;
}
