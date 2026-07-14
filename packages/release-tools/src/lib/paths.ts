import { existsSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageJsonName = "package.json";

export function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);

  while (dirname(current) !== current) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    current = dirname(current);
  }

  throw new Error(`Could not find pnpm-workspace.yaml from ${start}`);
}

export function modulePath(importMetaUrl: string) {
  return fileURLToPath(importMetaUrl);
}

export function isEntrypoint(importMetaUrl: string) {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(importMetaUrl) : false;
}

export function toPosixPath(path: string) {
  return path.split(sep).join(posix.sep);
}
