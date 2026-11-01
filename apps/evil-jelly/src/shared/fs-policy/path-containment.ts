import fs from "node:fs";
import path from "node:path";
import { getErrnoCode } from "../foundation/errno";

function normalizeComparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parentDir: string, targetPath: string): boolean {
  const parent = normalizeComparisonPath(parentDir);
  const target = normalizeComparisonPath(targetPath);
  const relativePath = path.relative(parent, target);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/** Check existing-parent realpaths too, so a missing target cannot escape through a link/junction. */
export function resolveRealPath(targetPath: string): string | undefined {
  let existing = path.resolve(targetPath);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing);
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") return undefined;
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function isRealPathInside(parentDir: string, targetPath: string): boolean {
  const realPath = resolveRealPath(targetPath);
  return realPath !== undefined && isPathInside(parentDir, realPath);
}
