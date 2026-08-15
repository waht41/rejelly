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

function containsPath(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
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
