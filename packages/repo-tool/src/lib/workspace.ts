import path from "node:path";
import { capture } from "./process.js";

export interface WorkspacePackage {
  name: string;
  path: string;
}

export interface AffectedPackages {
  packages: string[];
  unmappedFiles: string[];
}

export interface RootImpact {
  globalFiles: string[];
  neutralFiles: string[];
}

interface TurboPackageList {
  packages?: {
    items?: unknown[];
  };
}

export function loadWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  const result = capture("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], repoRoot);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "pnpm list failed");
  }
  const entries: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("pnpm list returned a non-array workspace result");
  const resolvedRoot = path.resolve(repoRoot);
  return entries.flatMap((entry): WorkspacePackage[] => {
    if (!entry || typeof entry !== "object") return [];
    const name = "name" in entry ? entry.name : undefined;
    const packagePath = "path" in entry ? entry.path : undefined;
    if (typeof name !== "string" || typeof packagePath !== "string") return [];
    const resolvedPath = path.resolve(packagePath);
    return resolvedPath === resolvedRoot ? [] : [{ name, path: resolvedPath }];
  });
}

export function resolveTurboFilteredPackages(
  repoRoot: string,
  filters: readonly string[],
): WorkspacePackage[] {
  const result = capture(
    "pnpm",
    ["exec", "turbo", "ls", "--output=json", ...filters.map((filter) => `--filter=${filter}`)],
    repoRoot,
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "turbo ls failed while resolving --filter");
  }
  const parsed: TurboPackageList = JSON.parse(result.stdout);
  const items = parsed.packages?.items;
  if (!Array.isArray(items)) throw new Error("turbo ls returned an invalid package list");
  return items.flatMap((entry): WorkspacePackage[] => {
    if (!entry || typeof entry !== "object") return [];
    const name = "name" in entry ? entry.name : undefined;
    const packagePath = "path" in entry ? entry.path : undefined;
    if (typeof name !== "string" || typeof packagePath !== "string") return [];
    return [{ name, path: path.resolve(repoRoot, packagePath) }];
  });
}

function containsPath(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function isNeutralRootPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  const name = normalized.toLowerCase();
  return (
    name.startsWith(".changeset/") ||
    name.startsWith(".github/") ||
    name.startsWith("docs/") ||
    name === ".editorconfig" ||
    name === ".gitattributes" ||
    name === ".gitignore" ||
    name === "license" ||
    name.startsWith("license.") ||
    name === "readme.md" ||
    name === "agents.md" ||
    name.endsWith("/agents.md") ||
    name === "agents.override.md"
  );
}

/** Unknown root files are global by default; only explicitly neutral paths may skip tasks. */
export function classifyRootImpact(files: readonly string[]): RootImpact {
  const globalFiles: string[] = [];
  const neutralFiles: string[] = [];
  for (const file of files) {
    (isNeutralRootPath(file) ? neutralFiles : globalFiles).push(file);
  }
  return { globalFiles, neutralFiles };
}

export function downstreamPackageFilters(packageNames: readonly string[]): string[] {
  return packageNames.map((name) => `...${name}`);
}

export function mapChangedPathsToPackages(
  repoRoot: string,
  files: readonly string[],
  workspacePackages: readonly WorkspacePackage[],
): AffectedPackages {
  const packagesByDepth = [...workspacePackages].sort(
    (left, right) => right.path.length - left.path.length,
  );
  const selected = new Set<string>();
  const unmappedFiles: string[] = [];
  for (const file of files) {
    const absolute = path.resolve(repoRoot, file);
    const owner = packagesByDepth.find((entry) => containsPath(entry.path, absolute));
    if (owner) selected.add(owner.name);
    else unmappedFiles.push(file);
  }
  return { packages: [...selected].sort(), unmappedFiles };
}

export function filterChangedPathsForPackages(
  repoRoot: string,
  files: readonly string[],
  workspacePackages: readonly WorkspacePackage[],
  selectedPackages: readonly WorkspacePackage[],
): string[] {
  const packagesByDepth = [...workspacePackages].sort(
    (left, right) => right.path.length - left.path.length,
  );
  const selectedNames = new Set(selectedPackages.map((entry) => entry.name));
  return files.filter((file) => {
    const absolute = path.resolve(repoRoot, file);
    const owner = packagesByDepth.find((entry) => containsPath(entry.path, absolute));
    return owner === undefined || selectedNames.has(owner.name);
  });
}
