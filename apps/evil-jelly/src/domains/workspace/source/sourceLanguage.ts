/** JS/TS source-language resolution from workspace-relative paths. */

import path from "node:path";
import { Lang } from "@ast-grep/napi";

export const AST_SCRIPT_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
] as const;

export function tryLangFromRelPath(relPath: string): Lang | null {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".tsx" || ext === ".jsx") {
    return Lang.Tsx;
  }
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    return Lang.TypeScript;
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return Lang.JavaScript;
  }
  return null;
}

export function langFromRelPath(relPath: string): Lang {
  return tryLangFromRelPath(relPath) ?? Lang.JavaScript;
}
