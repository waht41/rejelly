import { exec } from "./exec.js";
import { packageJsonName, toPosixPath } from "./paths.js";
import type { PublishablePackage } from "./workspace.js";

export type ChangedPackageDetail = {
  base?: string;
  files: string[];
  reason: "missing-release-tag" | "package-diff" | "root-impact";
};

export type ChangedPackagesResult = {
  details: Map<string, ChangedPackageDetail>;
  packages: Set<string>;
};

export const defaultRootImpactFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

export function git(repoRoot: string, args: string[], options: { ignoreErrors?: boolean } = {}) {
  return exec("git", args, {
    cwd: repoRoot,
    ignoreErrors: options.ignoreErrors,
  }).trim();
}

export function latestPackageTag(repoRoot: string, packageName: string) {
  const output = git(repoRoot, ["tag", "--list", `${packageName}@*`, "--sort=-version:refname"], {
    ignoreErrors: true,
  });

  return output.split(/\r?\n/).find(Boolean);
}

export function diffFilesFromBase(repoRoot: string, base?: string, pathspec = ".") {
  if (!base) {
    return [];
  }

  const output = git(repoRoot, ["diff", "--name-only", base, "--", pathspec], {
    ignoreErrors: true,
  });
  return output ? output.split(/\r?\n/).filter(Boolean).map(toPosixPath) : [];
}

export function commitSubjectsSince(repoRoot: string, base: string, pathspec = ".") {
  const output = git(repoRoot, ["log", "--format=%s", `${base}..HEAD`, "--", pathspec], {
    ignoreErrors: true,
  });
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

export function packageJsonAtRef(repoRoot: string, ref: string, packagePath: string) {
  const file = `${ref}:${packagePath}/${packageJsonName}`;

  try {
    return JSON.parse(git(repoRoot, ["show", file], { ignoreErrors: true }));
  } catch {
    return undefined;
  }
}

export function changedPackagesFromGit(
  repoRoot: string,
  packages: PublishablePackage[],
  options: { base?: string; rootImpact?: "all" | "none" } = {},
): ChangedPackagesResult {
  const details = new Map<string, ChangedPackageDetail>();

  if (options.base) {
    const changedFiles = diffFilesFromBase(repoRoot, options.base);
    const rootImpact =
      options.rootImpact === "all" && changedFiles.some((file) => defaultRootImpactFiles.has(file));

    if (rootImpact) {
      const rootFiles = changedFiles.filter((file) => defaultRootImpactFiles.has(file));
      return {
        details: new Map(
          packages.map((pkg) => [
            pkg.name,
            {
              base: options.base,
              files: rootFiles,
              reason: "root-impact",
            },
          ]),
        ),
        packages: new Set(packages.map((pkg) => pkg.name)),
      };
    }

    for (const pkg of packages) {
      const files = changedFiles.filter(
        (file) => file === pkg.path || file.startsWith(`${pkg.path}/`),
      );

      if (files.length > 0) {
        details.set(pkg.name, {
          base: options.base,
          files,
          reason: "package-diff",
        });
      }
    }

    return {
      details,
      packages: new Set(details.keys()),
    };
  }

  for (const pkg of packages) {
    const tag = latestPackageTag(repoRoot, pkg.name);

    if (!tag) {
      details.set(pkg.name, {
        base: undefined,
        files: [],
        reason: "missing-release-tag",
      });
      continue;
    }

    const files = diffFilesFromBase(repoRoot, tag, pkg.path);

    if (files.length > 0) {
      details.set(pkg.name, {
        base: tag,
        files,
        reason: "package-diff",
      });
    }
  }

  return {
    details,
    packages: new Set(details.keys()),
  };
}
