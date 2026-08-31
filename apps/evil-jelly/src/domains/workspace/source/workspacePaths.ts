import path from "node:path";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import { MAX_HEURISTIC_AST_FILES } from "./heuristicAstLimits";

const SCRIPT_PATH_PATTERN = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function isScriptPath(relPosix: string): boolean {
  return SCRIPT_PATH_PATTERN.test(relPosix);
}

export async function listWorkspaceScriptRelPaths(): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  return policy.walkFiles({
    maxFiles: MAX_HEURISTIC_AST_FILES,
    includeFile: isScriptPath,
  });
}

/**
 * Conventional documentation surface: every README plus docs/**. Draft trees are excluded — they
 * are moving targets by definition, not a published doc surface. Gitignore-aware, sorted, capped.
 */
export async function listWorkspaceDocRelPaths(maxFiles = 400): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const entries = await policy.walkFiles({
    maxFiles,
    includeFile: (rel) => {
      const segments = rel.split("/");
      if (segments.includes("draft")) {
        return false;
      }
      const fileName = segments.at(-1) ?? "";
      return /^README.*\.md$/.test(fileName) || (rel.startsWith("docs/") && rel.endsWith(".md"));
    },
  });
  return entries.sort();
}

/**
 * Script files under the given workspace-relative directory prefixes (a prefix may also name a
 * single file). Deduped across prefixes, gitignore-aware, sorted for deterministic downstream
 * hashing, capped at `maxFiles`.
 */
export async function listScriptRelPathsUnder(
  prefixes: string[],
  maxFiles = MAX_HEURISTIC_AST_FILES,
): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const roots = prefixes
    .map((prefix) => prefix.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((prefix) => prefix.length > 0 && !prefix.startsWith(".."));
  return policy.walkFiles({ roots, maxFiles, includeFile: isScriptPath });
}

export async function tryResolveRelativeImport(
  fromRel: string,
  specifier: string,
): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const policy = getWorkspaceFsPolicy();
  const dir = path.dirname(fromRel);
  const normalized = path.normalize(path.join(dir, specifier)).split(path.sep).join("/");
  const trials = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}.mjs`,
    `${normalized}.cjs`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
  ];
  for (const trial of trials) {
    try {
      const resolved = policy.tryResolve(trial, { intent: "read", access: "direct-read" });
      if (!resolved.ok) {
        continue;
      }
      const st = await policy.statResolved(resolved);
      if (st.isFile()) {
        return resolved.displayPath;
      }
    } catch {}
  }
  return null;
}
