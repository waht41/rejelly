import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "./exec.js";
import { git } from "./git.js";
import {
  comparePackage,
  currentPackHash,
  type PackHashOptions,
  resolvePackHashCandidates,
  withTempPackDir,
} from "./pack-hash.js";
import { packageJsonName } from "./paths.js";
import { expandWithDependents, type PublishablePackage } from "./workspace.js";

export type CanaryOptions = PackHashOptions & {
  dryRun?: boolean;
  registry: string;
};

export type CanaryEntry = {
  action: "publish" | "skip-exists";
  pkg: PublishablePackage;
  reason: "changed" | "dependent";
  version: string;
};

export type CanaryPlan = {
  dirty: boolean;
  entries: CanaryEntry[];
  sha: string;
  suffix: string;
};

/**
 * Build the canary publish plan without touching the working tree.
 *
 * A package is a *changed* seed when its packed contents differ from what the
 * target registry already serves for its stable version (reuses pack-hash's
 * normalized, version-stripped hash). Every dependent of a changed seed is
 * pulled in too — otherwise `pnpm publish` would replace its `workspace:*`
 * ranges with a version that never got a matching canary.
 */
export async function planCanary(
  repoRoot: string,
  packages: PublishablePackage[],
  options: CanaryOptions,
): Promise<CanaryPlan> {
  const sha = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const dirty = git(repoRoot, ["status", "--porcelain"], { ignoreErrors: true }).length > 0;

  const candidates = resolvePackHashCandidates(repoRoot, packages, options);

  const { changed, contentHash } = await withTempPackDir(async (tempDir) => {
    const names = new Set<string>();
    // Normalized, version-stripped hash of every changed package's working-tree
    // contents. Fully determines the plan: dependents only get republished as a
    // function of which seeds changed and their contents, so hashing the seeds
    // captures the whole snapshot.
    const hashes = new Map<string, string>();

    for (const pkg of candidates.packages) {
      const result = await comparePackage(repoRoot, pkg, options.registry, tempDir);
      if (result.status !== "unchanged") {
        names.add(pkg.name);
        // `comparePackage` only hashes when a stable version exists to diff
        // against; pack directly for new packages. Only needed when dirty.
        if (dirty) {
          hashes.set(
            pkg.name,
            result.status === "changed-same-version"
              ? result.currentHash
              : currentPackHash(repoRoot, pkg, tempDir),
          );
        }
      }
    }

    return { changed: names, contentHash: combineHashes(hashes) };
  });

  // Clean tree → deterministic, idempotent suffix. Dirty tree can't be pinned by
  // sha, so key the suffix on the working-tree contents instead: re-running an
  // unchanged dirty tree yields the same version (skippable), editing yields a
  // new one.
  const suffix = dirty ? `${sha}.dev${contentHash}` : sha;

  const included = expandWithDependents(changed, packages);
  const registry = ensureTrailingSlash(options.registry);

  const entries: CanaryEntry[] = [];

  for (const pkg of packages) {
    if (!included.has(pkg.name)) {
      continue;
    }

    const version = `${pkg.version}-canary.${suffix}`;
    const exists = await publishedVersionExists(registry, pkg.name, version);

    entries.push({
      action: exists ? "skip-exists" : "publish",
      pkg,
      reason: changed.has(pkg.name) ? "changed" : "dependent",
      version,
    });
  }

  return { dirty, entries, sha, suffix };
}

/**
 * Apply a plan: stamp the canary version onto *every* included package (so
 * cross-package `workspace:*` refs resolve to a real canary), build and publish
 * the ones that aren't already on the registry, then restore package.json.
 */
export function runCanary(repoRoot: string, plan: CanaryPlan, options: CanaryOptions) {
  const toPublish = plan.entries.filter((entry) => entry.action === "publish");

  if (toPublish.length === 0) {
    console.log("release-canary: nothing to publish (all up to date)");
    return;
  }

  const restore = plan.entries.map((entry) => stampVersion(repoRoot, entry));

  try {
    exec(
      "pnpm",
      ["exec", "turbo", "run", "build", ...toPublish.map((entry) => `--filter=${entry.pkg.name}`)],
      { cwd: repoRoot, stdio: "inherit" },
    );

    for (const entry of toPublish) {
      console.log(`release-canary: publishing ${entry.pkg.name}@${entry.version}`);
      exec(
        "pnpm",
        [
          "--filter",
          entry.pkg.name,
          "publish",
          "--tag",
          "canary",
          "--registry",
          options.registry,
          "--no-git-checks",
        ],
        { cwd: repoRoot, stdio: "inherit" },
      );
    }
  } finally {
    for (const undo of restore) {
      undo();
    }
  }
}

function stampVersion(repoRoot: string, entry: CanaryEntry) {
  const path = resolve(repoRoot, entry.pkg.path, packageJsonName);
  const original = readFileSync(path, "utf8");
  const json = JSON.parse(original);

  json.version = entry.version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);

  return () => writeFileSync(path, original);
}

async function publishedVersionExists(registry: string, name: string, version: string) {
  const encodedName = name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name);
  const response = await fetch(new URL(encodedName, registry).href, {
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`GET ${name} metadata failed: ${response.status} ${response.statusText}`);
  }

  const metadata = (await response.json()) as { versions?: Record<string, unknown> };
  return Boolean(metadata.versions?.[version]);
}

/**
 * Fold per-package content hashes into one short, order-independent digest for
 * the canary version suffix. Sorted by name so the result is stable regardless
 * of iteration order.
 */
function combineHashes(hashes: Map<string, string>) {
  const digest = createHash("sha256");

  for (const name of [...hashes.keys()].sort()) {
    digest.update(name);
    digest.update("\0");
    digest.update(hashes.get(name) as string);
    digest.update("\0");
  }

  return digest.digest("hex").slice(0, 12);
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
