import { readFileSync } from "node:fs";

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
