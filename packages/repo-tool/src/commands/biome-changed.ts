import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BiomeChangedSelection } from "../contracts.js";
import { collectChangedPaths } from "../lib/changes.js";
import { run } from "../lib/process.js";

export interface BiomeChangedOptions {
  allowMany: boolean;
  base?: string;
  maxFiles: number;
  selection?: BiomeChangedSelection;
  verbose: boolean;
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

export function existingBiomeCandidateFiles(repoRoot: string, files: readonly string[]): string[] {
  const resolvedRoot = path.resolve(repoRoot);
  return files.filter((file) => existsSync(path.join(resolvedRoot, file))).sort();
}

export function exceedsBiomeWriteLimit(
  fileCount: number,
  options: Pick<BiomeChangedOptions, "allowMany" | "maxFiles" | "write">,
): boolean {
  return options.write && !options.allowMany && fileCount > options.maxFiles;
}

function contentHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function changedByWrite(
  repoRoot: string,
  files: readonly string[],
  before: ReadonlyMap<string, string>,
): string[] {
  return files.filter((file) => {
    const absolute = path.join(repoRoot, file);
    return existsSync(absolute) && before.get(file) !== contentHash(absolute);
  });
}

export function runBiomeChanged(repoRoot: string, options: BiomeChangedOptions): number {
  const candidate = options.selection ?? collectBiomeChangedFiles(repoRoot, options.base);
  const base = candidate.base;
  const resolvedRoot = path.resolve(repoRoot);
  const files = existingBiomeCandidateFiles(repoRoot, candidate.files);
  console.log(
    `Biome ${options.write ? "write" : "check"}: ${files.length} changed candidate(s), base ${base}`,
  );
  if (options.verbose) {
    for (const file of files) console.log(`  ${file}`);
  }
  if (files.length === 0) return 0;
  if (exceedsBiomeWriteLimit(files.length, options)) {
    throw new Error(
      `Refusing to modify ${files.length} files (limit ${options.maxFiles}); inspect the scope or pass --allow-many`,
    );
  }
  const before = options.write
    ? new Map(files.map((file) => [file, contentHash(path.join(resolvedRoot, file))]))
    : new Map<string, string>();
  const batches = chunkBiomePaths(files);
  let status = 0;
  for (const [index, batch] of batches.entries()) {
    if (batches.length > 1) console.log(`Biome batch ${index + 1}/${batches.length}`);
    status = run(
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
    if (status !== 0) break;
  }
  if (options.write) {
    const modified = changedByWrite(resolvedRoot, files, before);
    console.log(`Biome write: modified ${modified.length} file(s)`);
    if (options.verbose) {
      for (const file of modified) console.log(`  ${file}`);
    }
  }
  return status;
}
