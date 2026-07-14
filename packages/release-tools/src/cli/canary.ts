#!/usr/bin/env node
import { cac } from "cac";
import { type CanaryOptions, planCanary, runCanary } from "../lib/canary.js";
import { findRepoRoot, isEntrypoint } from "../lib/paths.js";
import { formatPackageSet, loadPublishablePackages } from "../lib/workspace.js";

const DEFAULT_REGISTRY = "http://localhost:4873/";

export async function main(argv = process.argv.slice(2)) {
  const cli = cac("release-canary");

  cli
    .option("--base <ref>", "Only consider packages affected since ref. Uses turbo dry-run first.")
    .option("--all", "Consider every publishable package, ignoring --base.", { default: false })
    .option("--registry <url>", "Target registry for canary publishes.", {
      default: DEFAULT_REGISTRY,
    })
    .option("--turbo-task <task>", "Task used for turbo affected dry-run.", { default: "build" })
    .option("--dry-run", "Print the plan without building or publishing.", { default: false })
    .help();

  const parsed = cli.parse(["node", "release-canary", ...argv], { run: false });

  if (parsed.options.help) {
    return;
  }

  const options = normalizeOptions(parsed.options);

  // Canary is a local dev loop. Refuse the public registry so a stray --registry
  // (or an env default) can't leak commit-tagged prereleases to npmjs.
  if (/registry\.npmjs\.org/.test(options.registry)) {
    throw new Error(
      "release-canary: refusing to publish to the public npm registry. Use a local registry.",
    );
  }

  const repoRoot = findRepoRoot();
  const packages = loadPublishablePackages(repoRoot);
  const plan = await planCanary(repoRoot, packages, options);

  console.log(
    `release-canary: sha=${plan.sha}${plan.dirty ? " (dirty)" : ""} registry=${options.registry}`,
  );
  console.log(`release-canary: publish=${formatPackageSet(publishNames(plan))}`);
  console.log(`release-canary: skip=${formatPackageSet(skipNames(plan))}`);

  for (const entry of plan.entries) {
    console.log(
      `release-canary:   ${entry.pkg.name}@${entry.version} [${entry.reason}] ${entry.action}`,
    );
  }

  if (options.dryRun) {
    return;
  }

  runCanary(repoRoot, plan, options);
}

function normalizeOptions(options: Record<string, unknown>): CanaryOptions {
  const registry = typeof options.registry === "string" ? options.registry : DEFAULT_REGISTRY;

  return {
    all: options.all === true,
    base: typeof options.base === "string" ? options.base : undefined,
    dryRun: options.dryRun === true,
    registry: registry.endsWith("/") ? registry : `${registry}/`,
    turboTask: typeof options.turboTask === "string" ? options.turboTask : "build",
  };
}

function publishNames(plan: { entries: { action: string; pkg: { name: string } }[] }) {
  return plan.entries.filter((entry) => entry.action === "publish").map((entry) => entry.pkg.name);
}

function skipNames(plan: { entries: { action: string; pkg: { name: string } }[] }) {
  return plan.entries
    .filter((entry) => entry.action === "skip-exists")
    .map((entry) => entry.pkg.name);
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
