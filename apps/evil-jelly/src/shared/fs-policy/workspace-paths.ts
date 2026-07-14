import path from "node:path";
import fg from "fast-glob";
import { MAX_HEURISTIC_AST_FILES } from "../lib/heuristicAstLimits";
import { getWorkspaceFsPolicy } from "./workspace-fs-policy";

export async function listWorkspaceScriptRelPaths(): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const rootAbs = policy.getRoot();
  const entries = await fg(["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], {
    cwd: rootAbs,
    dot: false,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"],
    absolute: false,
    onlyFiles: true,
  });
  const norm = entries.map((p) => p.split(path.sep).join("/"));
  const filtered: string[] = [];
  for (const rel of norm) {
    if (filtered.length >= MAX_HEURISTIC_AST_FILES) {
      break;
    }
    if (policy.isIgnoredByGitignore(rel, false)) {
      continue;
    }
    filtered.push(rel);
  }
  return filtered;
}

/**
 * Conventional documentation surface: every README plus docs/**. Draft trees are excluded — they
 * are moving targets by definition, not a published doc surface. Gitignore-aware, sorted, capped.
 */
export async function listWorkspaceDocRelPaths(maxFiles = 400): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const entries = await fg(["**/README*.md", "docs/**/*.md"], {
    cwd: policy.getRoot(),
    dot: false,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/draft/**",
    ],
    absolute: false,
    onlyFiles: true,
  });
  const filtered: string[] = [];
  for (const rel of [...new Set(entries.map((p) => p.split(path.sep).join("/")))].sort()) {
    if (filtered.length >= maxFiles) {
      break;
    }
    if (policy.isIgnoredByGitignore(rel, false)) {
      continue;
    }
    filtered.push(rel);
  }
  return filtered;
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
  const rootAbs = policy.getRoot();
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    const clean = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean || clean.startsWith("..")) {
      continue;
    }
    const entries = await fg([clean, `${clean}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`], {
      cwd: rootAbs,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"],
      absolute: false,
      onlyFiles: true,
    });
    for (const entry of entries) {
      seen.add(entry.split(path.sep).join("/"));
    }
  }
  const filtered: string[] = [];
  for (const rel of [...seen].sort()) {
    if (filtered.length >= maxFiles) {
      break;
    }
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(rel)) {
      continue;
    }
    if (policy.isIgnoredByGitignore(rel, false)) {
      continue;
    }
    filtered.push(rel);
  }
  return filtered;
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
  for (const rel of trials) {
    try {
      const st = await policy.stat(rel);
      if (st.isFile()) {
        return rel;
      }
    } catch {}
  }
  return null;
}
