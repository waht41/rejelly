import path from "node:path";
import { isPathInside } from "../../../shared/fs-policy/path-containment";
import type { ExternalFileAccess } from "../../../shared/host/toolConfirmationBindings";

function normalizeGrantPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Session-lived grants for paths outside one workspace root. */
export class ExternalFileGrants {
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
    const normalized = normalizeGrantPath(dirPath);
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
