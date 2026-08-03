/**
 * Cross-platform path helpers (POSIX shape for git / diff display).
 */

import path from "node:path";
import { Lang } from "@ast-grep/napi";

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Convert an already-validated POSIX-shaped relative path for native filesystem APIs. */
export function fromPosixPath(posixPath: string): string {
  return path.sep === "/" ? posixPath : posixPath.replaceAll("/", path.sep);
}

export function toRepoRelativePath(gitRoot: string, absolutePath: string): string {
  const rel = path.relative(gitRoot, path.resolve(absolutePath));
  return toPosixPath(rel);
}

const TEST_OR_GENERATED_RE =
  /(^|\/)(__tests__|__fixtures__|__snapshots__|__mocks__|node_modules|dist|build|coverage|\.turbo)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.gen\.[cm]?[jt]sx?$|\.d\.ts$|(^|\/)generated(\/|$)/;

/** Whether a path is test/fixture/generated code (intentional boilerplate, not a refactor target). */
export function isTestOrGeneratedPath(file: string): boolean {
  return TEST_OR_GENERATED_RE.test(file);
}

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
  const lang = tryLangFromRelPath(relPath);
  if (lang) {
    return lang;
  }
  return Lang.JavaScript;
}
