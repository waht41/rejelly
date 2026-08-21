import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (dirname(current) !== current) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not find pnpm-workspace.yaml from ${start}`);
}

export function isEntrypoint(importMetaUrl: string): boolean {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(importMetaUrl) : false;
}
