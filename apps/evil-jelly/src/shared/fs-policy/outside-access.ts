import fs from "node:fs";
import path from "node:path";

export type ExternalFileAccess = "read" | "scan" | "write";

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
export class ExternalAccessRegistry {
  private readonly approvedReadDirs = new Set<string>();
  private readonly approvedScanDirs = new Set<string>();
  private readonly approvedWriteDirs = new Set<string>();

  has(access: ExternalFileAccess, targetPath: string): boolean {
    const dirs =
      access === "write"
        ? this.approvedWriteDirs
        : access === "scan"
          ? this.approvedScanDirs
          : this.approvedReadDirs;
    for (const dir of dirs) {
      if (isPathInside(dir, targetPath)) {
        return true;
      }
    }
    if (access === "read") {
      for (const dir of this.approvedScanDirs) {
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

  approve(access: ExternalFileAccess, dirPath: string): void {
    const normalized = normalizeAccessPath(dirPath);
    if (access === "write") {
      this.approvedWriteDirs.add(normalized);
      this.approvedReadDirs.add(normalized);
      return;
    }
    if (access === "scan") {
      this.approvedScanDirs.add(normalized);
      this.approvedReadDirs.add(normalized);
      return;
    }
    this.approvedReadDirs.add(normalized);
  }
}
