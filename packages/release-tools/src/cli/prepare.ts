#!/usr/bin/env node
import { cac } from "cac";
import { findRepoRoot, isEntrypoint } from "../lib/paths.js";
import { buildPreparePlan, type PreparePlan } from "../lib/prepare.js";
import { loadPublishablePackages } from "../lib/workspace.js";

export function main(argv = process.argv.slice(2)) {
  const cli = cac("release-prepare");

  cli
    .option("--json", "Emit the plan as JSON (feed to an agent to write changesets).", {
      default: false,
    })
    .option("--max-files <n>", "Truncate the printed file list per package.", {
      default: 20,
    })
    .help();

  const parsed = cli.parse(["node", "release-prepare", ...argv], { run: false });

  if (parsed.options.help) {
    return;
  }

  const repoRoot = findRepoRoot();
  const packages = loadPublishablePackages(repoRoot);
  const plan = buildPreparePlan(repoRoot, packages);

  if (parsed.options.json === true) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  printPlan(plan, toMaxFiles(parsed.options.maxFiles));
}

function printPlan(plan: PreparePlan, maxFiles: number) {
  const changed = plan.packages.filter((pkg) => pkg.status === "changed");
  const noBaseline = plan.packages.filter((pkg) => pkg.status === "no-baseline");

  if (plan.packages.length === 0) {
    console.log("release-prepare: nothing changed since the last release tags.");
    return;
  }

  for (const pkg of changed) {
    if (pkg.status !== "changed") {
      continue;
    }

    console.log("");
    console.log(`${pkg.name}@${pkg.version}  base=${pkg.base}  declared=${yesNo(pkg.declared)}`);

    if (pkg.commits.length > 0) {
      console.log("  commits since base (level signal):");
      for (const subject of pkg.commits) {
        console.log(`    - ${subject}`);
      }
    }

    console.log(`  files changed (${pkg.files.length}):`);
    for (const file of pkg.files.slice(0, maxFiles)) {
      console.log(`    ${file}`);
    }
    if (pkg.files.length > maxFiles) {
      console.log(`    ... ${pkg.files.length - maxFiles} more`);
    }
  }

  if (noBaseline.length > 0) {
    console.log("");
    console.log("no baseline (no release tag yet — first publish, diff skipped):");
    for (const pkg of noBaseline) {
      console.log(`  - ${pkg.name}@${pkg.version}  declared=${yesNo(pkg.declared)}`);
    }
  }

  console.log("");
  if (!plan.hasBaseline) {
    console.log(
      "release-prepare: no release tags exist yet — run `changeset publish` once to establish baselines, then this can diff.",
    );
  }
  console.log(
    "release-prepare: assign a level (major|minor|patch) per changed package and write the changesets.",
  );
}

function toMaxFiles(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
}

function yesNo(value: boolean) {
  return value ? "yes" : "no";
}

if (isEntrypoint(import.meta.url)) {
  main();
}
