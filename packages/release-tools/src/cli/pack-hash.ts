#!/usr/bin/env node
import { cac } from "cac";
import { comparePackage, resolvePackHashCandidates, withTempPackDir } from "../lib/pack-hash.js";
import { findRepoRoot, isEntrypoint } from "../lib/paths.js";
import { formatPackageSet, loadPublishablePackages } from "../lib/workspace.js";

type CheckMode = "error" | "warn" | "off";
type RootImpact = "all" | "none";

type PackHashOptions = {
  all: boolean;
  base?: string;
  check: CheckMode;
  registry?: string;
  rootImpact: RootImpact;
  turboTask: string;
};

export async function main(argv = process.argv.slice(2)) {
  const cli = cac("release-pack-hash");

  cli
    .option("--base <ref>", "Only hash packages affected since ref. Uses turbo dry-run first.")
    .option("--all", "Check every publishable package, ignoring --base.", {
      default: false,
    })
    .option("--registry <url>", "Registry base URL. Overrides package publishConfig.registry.")
    .option("--turbo-task <task>", "Task used for turbo affected dry-run.", {
      default: "build",
    })
    .option("--root-impact <mode>", "all | none. Used by git fallback.", {
      default: "all",
    })
    .option("--check <mode>", "error | warn | off.", {
      default: process.env.CI ? "error" : "warn",
    })
    .help();

  const parsed = cli.parse(["node", "release-pack-hash", ...argv], { run: false });

  if (parsed.options.help) {
    return;
  }

  const options = normalizeOptions(parsed.options);

  const repoRoot = findRepoRoot();
  const packages = loadPublishablePackages(repoRoot);
  const candidates = resolvePackHashCandidates(repoRoot, packages, options);

  console.log(
    `release-pack-hash: candidates=${formatPackageSet(candidates.packages.map((pkg) => pkg.name))} source=${candidates.source}`,
  );

  const results = await withTempPackDir(async (tempDir) => {
    const comparisons = [];

    for (const pkg of candidates.packages) {
      console.log(`release-pack-hash: checking ${pkg.name}@${pkg.version}`);
      comparisons.push(await comparePackage(repoRoot, pkg, options.registry, tempDir));
    }

    return comparisons;
  });

  const violations = results.filter((result) => result.status === "changed-same-version");

  for (const result of results) {
    if (result.status === "new-version") {
      console.log(`release-pack-hash: ${result.name}@${result.version} is not published yet`);
    } else if (result.status === "unchanged") {
      console.log(`release-pack-hash: ${result.name}@${result.version} unchanged`);
    }
  }

  if (violations.length === 0) {
    console.log("release-pack-hash: ok");
    return;
  }

  console.error("release-pack-hash: package contents changed without a version bump:");

  for (const violation of violations) {
    console.error(`  - ${violation.name}@${violation.version}`);
    if (violation.status === "changed-same-version") {
      console.error(`    current=${violation.currentHash}`);
      console.error(`    remote =${violation.remoteHash}`);
    }
  }

  if (options.check === "error") {
    process.exitCode = 1;
  }
}

function normalizeOptions(options: Record<string, unknown>): PackHashOptions {
  const check = oneOf(options.check, ["error", "warn", "off"], "--check");
  const rootImpact = oneOf(options.rootImpact, ["all", "none"], "--root-impact");
  const registry =
    typeof options.registry === "string" ? ensureTrailingSlash(options.registry) : undefined;

  return {
    all: options.all === true,
    base: typeof options.base === "string" ? options.base : undefined,
    check,
    registry,
    rootImpact,
    turboTask: typeof options.turboTask === "string" ? options.turboTask : "build",
  };
}

function oneOf<const T extends string>(value: unknown, values: readonly T[], flag: string): T {
  if (typeof value === "string" && values.includes(value as T)) {
    return value as T;
  }

  throw new Error(`${flag} must be one of: ${values.join(", ")}`);
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
