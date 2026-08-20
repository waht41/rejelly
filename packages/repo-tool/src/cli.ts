#!/usr/bin/env node
import { cac } from "cac";
import { runBiomeChanged } from "./commands/biome-changed.js";
import { runBranchReport } from "./commands/branch-report.js";
import { runVerify } from "./commands/verify.js";
import type { BiomeScope, VerifyOptions } from "./contracts.js";
import { findRepoRoot, isEntrypoint } from "./lib/repo.js";

function strings(value: unknown): string[] {
  if (value === undefined || value === false) return [];
  return (Array.isArray(value) ? value : [value])
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} requires a positive integer`);
  return parsed;
}

function biomeScope(value: unknown, all: boolean): BiomeScope {
  const scope = value === undefined ? (all ? "all" : "changed") : String(value);
  if (scope === "all" || scope === "changed" || scope === "skip") return scope;
  throw new Error("--biome must be one of: changed, all, skip");
}

export function normalizeVerifyOptions(options: Record<string, unknown>): VerifyOptions {
  const filters = strings(options.filter);
  const all = options.all === true;
  const biome = biomeScope(options.biome, all);
  const fix = options.fix === true;
  if (all && filters.length > 0) throw new Error("--all cannot be combined with --filter");
  if (fix && biome === "skip") throw new Error("--fix cannot be combined with --biome skip");
  return {
    allowMany: options.allowMany === true,
    base: typeof options.base === "string" ? options.base : undefined,
    biome,
    dryRun: options.dryRun === true,
    fix,
    maxFiles: positiveInteger(options.maxFiles, "--max-files", 100),
    scope: all
      ? { kind: "all" }
      : filters.length > 0
        ? { filters, kind: "filtered" }
        : { kind: "affected" },
    tests: options.tests !== false,
    verbose: options.verbose === true,
  };
}

export function main(argv = process.argv.slice(2)): void {
  const cli = cac("repo-tool");

  cli
    .command("verify", "Run repository verification as one high-level operation")
    .option("--filter <package>", "Turbo package filter (repeatable)")
    .option("--all", "Verify every workspace package and all Biome files")
    .option("--fix", "Apply Biome safe fixes, formatting, and import sorting before verification")
    .option("--no-tests", "Skip test tasks")
    .option("--biome <scope>", "Biome scope: changed, all, or skip")
    .option("--base <ref>", "Base ref used by the changed-file Biome check")
    .option("--max-files <count>", "Changed-file write safety limit", { default: 100 })
    .option("--allow-many", "Bypass the changed-file write safety limit")
    .option("--dry-run", "Print the verification plan without running it")
    .option("--verbose", "List files selected or modified by Biome")
    .action((options: Record<string, unknown>) => {
      process.exitCode = runVerify(findRepoRoot(), normalizeVerifyOptions(options));
    });

  cli
    .command("branch-report", "Summarize branch commits and working-tree state")
    .option("--base <ref>", "Comparison base (default: origin/main or main)")
    .option("--json", "Print structured JSON")
    .action((options: Record<string, unknown>) => {
      runBranchReport(findRepoRoot(), {
        base: typeof options.base === "string" ? options.base : undefined,
        json: options.json === true,
      });
    });

  cli
    .command("biome-changed", "Check or format changed files with Biome")
    .option("--write", "Apply safe fixes and formatting")
    .option("--base <ref>", "Comparison base (default: origin/main or main)")
    .option("--max-files <count>", "Changed-file write safety limit", { default: 100 })
    .option("--allow-many", "Bypass the changed-file write safety limit")
    .option("--verbose", "List files selected or modified by Biome")
    .action((options: Record<string, unknown>) => {
      process.exitCode = runBiomeChanged(findRepoRoot(), {
        allowMany: options.allowMany === true,
        base: typeof options.base === "string" ? options.base : undefined,
        maxFiles: positiveInteger(options.maxFiles, "--max-files", 100),
        verbose: options.verbose === true,
        write: options.write === true,
      });
    });

  cli.help();
  cli.parse(["node", "repo-tool", ...argv]);
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[repo-tool] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
