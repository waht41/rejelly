import fs from "node:fs";
import path from "node:path";

export type OutsideAccessMode = "read" | "search" | "write";

function normalizeAccessPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parentDir: string, targetPath: string): boolean {
  const parent = normalizeAccessPath(parentDir);
  const target = normalizeAccessPath(targetPath);
  const relativePath = path.relative(parent, target);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export function suggestOutsideApproveDir(targetPath: string): string {
  const abs = path.resolve(targetPath);
  try {
    const stat = fs.statSync(abs);
    return stat.isDirectory() ? abs : path.dirname(abs);
  } catch {
    return path.dirname(abs);
  }
}

/**
 * Approved outside-workspace directories. Owned by a WorkspaceFsPolicy instance, so approvals
 * are scoped to one workspace root and vanish when the root is replaced.
 */
export class OutsideAccessRegistry {
  private readonly approvedReadDirs = new Set<string>();
  private readonly approvedSearchDirs = new Set<string>();
  private readonly approvedWriteDirs = new Set<string>();

  has(mode: OutsideAccessMode, targetPath: string): boolean {
    const dirs =
      mode === "write"
        ? this.approvedWriteDirs
        : mode === "search"
          ? this.approvedSearchDirs
          : this.approvedReadDirs;
    for (const dir of dirs) {
      if (isPathInside(dir, targetPath)) {
        return true;
      }
    }
    if (mode === "read") {
      for (const dir of this.approvedSearchDirs) {
        if (isPathInside(dir, targetPath)) {
          return true;
        }
      }
      for (const dir of this.approvedWriteDirs) {
        if (isPathInside(dir, targetPath)) {
          return true;
        }
      }
    }
    return false;
  }

  approve(mode: OutsideAccessMode, dirPath: string): void {
    const normalized = normalizeAccessPath(dirPath);
    if (mode === "write") {
      this.approvedWriteDirs.add(normalized);
      this.approvedSearchDirs.add(normalized);
      this.approvedReadDirs.add(normalized);
      return;
    }
    if (mode === "search") {
      this.approvedSearchDirs.add(normalized);
      this.approvedReadDirs.add(normalized);
      return;
    }
    this.approvedReadDirs.add(normalized);
  }
}
