import { releasedPackagesFromChangesets } from "./changesets.js";
import { changedPackagesFromGit, commitSubjectsSince } from "./git.js";
import type { PublishablePackage } from "./workspace.js";

export type PreparePackagePlan = {
  declared: boolean;
  name: string;
  version: string;
} & (
  | { status: "no-baseline" }
  | { base: string; commits: string[]; files: string[]; status: "changed" }
);

export type PreparePlan = {
  hasBaseline: boolean;
  packages: PreparePackagePlan[];
};

/**
 * Collect the inputs an author/agent needs to write changesets at the release gate:
 * which packages changed, their diff against the last release tag, and the commit
 * subjects since that tag (the cheap, never-stale level signal).
 *
 * Packages without a release tag get status "no-baseline" — there is nothing to diff
 * against, so we deliberately skip the diff instead of fabricating one.
 */
export function buildPreparePlan(repoRoot: string, packages: PublishablePackage[]): PreparePlan {
  const changed = changedPackagesFromGit(repoRoot, packages);
  const declared = releasedPackagesFromChangesets(repoRoot);
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  const plans: PreparePackagePlan[] = [];
  let hasBaseline = false;

  for (const [name, detail] of changed.details) {
    const pkg = packageByName.get(name);

    if (!pkg) {
      continue;
    }

    const common = { declared: declared.has(name), name, version: pkg.version };

    if (detail.reason === "missing-release-tag" || !detail.base) {
      plans.push({ ...common, status: "no-baseline" });
      continue;
    }

    hasBaseline = true;
    plans.push({
      ...common,
      base: detail.base,
      commits: commitSubjectsSince(repoRoot, detail.base, pkg.path),
      files: detail.files,
      status: "changed",
    });
  }

  return {
    hasBaseline,
    packages: plans.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
