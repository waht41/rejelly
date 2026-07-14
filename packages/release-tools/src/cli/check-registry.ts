#!/usr/bin/env node
import { cac } from "cac";
import { findRepoRoot, isEntrypoint } from "../lib/paths.js";
import { loadPublishablePackages } from "../lib/workspace.js";

const DEFAULT_FALLBACK = "https://registry.npmjs.org/";

/**
 * Publish-gate guard: assert every publishable package resolves to the *expected*
 * registry before `changeset publish` runs. A package without publishConfig.registry
 * falls back to the npm config registry (usually npmjs) — which is exactly how a
 * package can leak to the public registry by accident. Fail loud instead.
 */
export function main(argv = process.argv.slice(2)) {
  const cli = cac("release-check-registry");

  cli
    .option("--expect <registry>", "Every publishable package must resolve to this registry.")
    .help();

  const parsed = cli.parse(["node", "release-check-registry", ...argv], { run: false });

  if (parsed.options.help) {
    return;
  }

  const expect = parsed.options.expect;

  if (typeof expect !== "string" || expect.length === 0) {
    throw new Error("--expect <registry> is required");
  }

  const expected = ensureTrailingSlash(expect);
  const repoRoot = findRepoRoot();
  const packages = loadPublishablePackages(repoRoot);
  const fallback = ensureTrailingSlash(process.env.npm_config_registry ?? DEFAULT_FALLBACK);

  const mismatches = packages
    .map((pkg) => ({ effective: ensureTrailingSlash(pkg.registry ?? fallback), name: pkg.name }))
    .filter((entry) => entry.effective !== expected);

  console.log(`release-check-registry: expect=${expected} packages=${packages.length}`);

  if (mismatches.length === 0) {
    console.log("release-check-registry: ok");
    return;
  }

  console.error(
    `release-check-registry: ${mismatches.length} package(s) resolve to the wrong registry:`,
  );

  for (const entry of mismatches) {
    console.error(`  - ${entry.name} -> ${entry.effective}`);
  }

  process.exitCode = 1;
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

if (isEntrypoint(import.meta.url)) {
  main();
}
