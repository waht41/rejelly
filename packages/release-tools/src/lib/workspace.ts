import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "./fs.js";
import { packageJsonName, toPosixPath } from "./paths.js";

export type PublishablePackage = {
  dependencies: Set<string>;
  name: string;
  path: string;
  registry?: string;
  version: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  publishConfig?: {
    registry?: string;
  };
  version?: string;
};

export function loadPublishablePackages(repoRoot: string) {
  const ignored = loadChangesetIgnore(repoRoot);
  const packages: PublishablePackage[] = [];

  for (const pattern of parseWorkspacePackagePatterns(repoRoot)) {
    for (const workspacePath of expandWorkspacePattern(repoRoot, pattern)) {
      const packageJsonPath = resolve(repoRoot, workspacePath, packageJsonName);

      if (!existsSync(packageJsonPath)) {
        continue;
      }

      const json = readJson<PackageJson>(packageJsonPath);

      if (!json.name || !json.version || json.private || ignored.has(json.name)) {
        continue;
      }

      packages.push({
        dependencies: collectWorkspaceDependencies(json),
        name: json.name,
        path: toPosixPath(workspacePath),
        registry: json.publishConfig?.registry,
        version: json.version,
      });
    }
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function expandWithDependents(
  packageNames: Iterable<string>,
  packages: PublishablePackage[],
) {
  const result = new Set<string>(packageNames);
  let changed = true;

  while (changed) {
    changed = false;

    for (const pkg of packages) {
      if (result.has(pkg.name)) {
        continue;
      }

      if ([...pkg.dependencies].some((dependency) => result.has(dependency))) {
        result.add(pkg.name);
        changed = true;
      }
    }
  }

  return result;
}

export function formatPackageSet(packageNames: Iterable<string>) {
  return [...packageNames].sort().join(", ") || "(none)";
}

function loadChangesetIgnore(repoRoot: string) {
  const configPath = resolve(repoRoot, ".changeset/config.json");

  if (!existsSync(configPath)) {
    return new Set();
  }

  return new Set(readJson<{ ignore?: string[] }>(configPath).ignore ?? []);
}

function parseWorkspacePackagePatterns(repoRoot: string) {
  const yaml = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
  const patterns = [];
  let inPackages = false;

  for (const line of yaml) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === "packages:";
      continue;
    }

    if (!inPackages) {
      continue;
    }

    const match = line.match(/^\s*-\s+(.+?)\s*$/);
    if (match) {
      patterns.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }

  return patterns;
}

function expandWorkspacePattern(repoRoot: string, pattern: string) {
  const parts = pattern.split("/");
  const wildcardIndex = parts.findIndex((part) => part.includes("*"));

  if (wildcardIndex === -1) {
    return [pattern];
  }

  if (parts.slice(wildcardIndex + 1).some((part) => part.includes("*"))) {
    throw new Error(`Only one-segment workspace globs are supported: ${pattern}`);
  }

  const beforeWildcard = parts.slice(0, wildcardIndex).join("/");
  const afterWildcard = parts.slice(wildcardIndex + 1);
  const wildcardPattern = new RegExp(
    `^${parts[wildcardIndex].split("*").map(escapeRegex).join(".*")}$`,
  );
  const baseDir = resolve(repoRoot, beforeWildcard);

  if (!existsSync(baseDir)) {
    return [];
  }

  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => wildcardPattern.test(entry.name))
    .map((entry) => [beforeWildcard, entry.name, ...afterWildcard].filter(Boolean).join("/"));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectWorkspaceDependencies(json: PackageJson) {
  const sections = [
    json.dependencies,
    json.peerDependencies,
    json.optionalDependencies,
    json.devDependencies,
  ];

  return new Set(
    sections.flatMap((section) =>
      Object.entries(section ?? {})
        .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
        .map(([name]) => name),
    ),
  );
}
