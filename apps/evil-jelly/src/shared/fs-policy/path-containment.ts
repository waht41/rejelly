import path from "node:path";

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
