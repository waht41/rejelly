/**
 * Shared helpers for heuristic AST tool services (parse and workspace declaration scan).
 */

import type { Lang, SgNode } from "@ast-grep/napi";
import { getWorkspaceFiles, type ResolvedFsPath } from "../../../shared/fs-policy/workspace-files";
import type { WorkspaceDirEntry } from "../../../shared/fs-policy/workspace-scan";
import { resolveFileToolPath } from "../file-access/resolveFileToolPath";
import { MAX_HEURISTIC_AST_FILES, MAX_HEURISTIC_RESULTS } from "../source/heuristicAstLimits";
import { tryLangFromRelPath } from "../source/sourceLanguage";
import { listWorkspaceScriptRelPaths } from "../source/workspacePaths";
import {
  type ParseWorkspaceAstOptions,
  parseWorkspaceRelToAst,
  tryParseWorkspaceRel,
} from "./heuristicAstCore";
import {
  collectDocumentSymbols,
  filterDeclarationsByName,
  type HeuristicSymbolRow,
} from "./queries";

/**
 * Resolve user path under cwd, read bounded source, infer language, parse AST.
 * Shared by single-file AST tools to avoid duplicated resolve/read/parse boilerplate.
 */
export async function getParsedAst(
  filePath: string,
  options?: ParseWorkspaceAstOptions,
): Promise<
  { ok: true; rel: string; text: string; root: SgNode; lang: Lang } | { ok: false; error: string }
> {
  const resolved = await resolveFileToolPath(filePath, { kind: "read" });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  return parseWorkspaceRelToAst(resolved.displayPath, options);
}

export type DeclHit = HeuristicSymbolRow & { file: string };

const MAX_ROOT_SCAN_ENTRIES = 50_000;

async function listScriptPathsForRoots(roots?: readonly string[]): Promise<string[]> {
  if (!roots) {
    return listWorkspaceScriptRelPaths();
  }

  const policy = getWorkspaceFiles();
  const files: string[] = [];
  const seen = new Set<string>();
  let visitedEntries = 0;

  const considerFile = (file: ResolvedFsPath) => {
    if (files.length >= MAX_HEURISTIC_AST_FILES || !tryLangFromRelPath(file.displayPath)) {
      return;
    }
    const key = process.platform === "win32" ? file.abs.toLowerCase() : file.abs;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    files.push(file.displayPath);
  };

  const visitDirectory = async (directory: ResolvedFsPath): Promise<void> => {
    if (files.length >= MAX_HEURISTIC_AST_FILES || visitedEntries >= MAX_ROOT_SCAN_ENTRIES) {
      return;
    }
    let entries: WorkspaceDirEntry[];
    try {
      entries = await policy.readdirResolved(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_HEURISTIC_AST_FILES || visitedEntries >= MAX_ROOT_SCAN_ENTRIES) {
        return;
      }
      visitedEntries += 1;
      if (entry.isSymbolicLink?.() || policy.shouldSkipResolvedEntry(directory, entry)) {
        continue;
      }
      const child = policy.childResolved(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(child);
      } else {
        considerFile(child);
      }
    }
  };

  for (const root of roots) {
    const resolved = await resolveFileToolPath(root, { kind: "scan" });
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    const stat = await policy.statResolved(resolved);
    if (stat.isDirectory()) {
      await visitDirectory(resolved);
    } else if (stat.isFile()) {
      considerFile(resolved);
    }
  }
  return files;
}

export async function collectMatchingDeclarations(
  symbolName: string,
  caseInsensitive: boolean,
  roots?: readonly string[],
): Promise<DeclHit[]> {
  const files = await listScriptPathsForRoots(roots);
  const hits: DeclHit[] = [];
  outer: for (const rel of files) {
    const parsed = await tryParseWorkspaceRel(rel);
    if (!parsed) {
      continue;
    }
    const { root, lang } = parsed;
    const rows = filterDeclarationsByName(
      collectDocumentSymbols(root, lang),
      symbolName,
      caseInsensitive,
    );
    for (const row of rows) {
      hits.push({ ...row, file: rel.replace(/\\/g, "/") });
      if (hits.length >= MAX_HEURISTIC_RESULTS) {
        break outer;
      }
    }
  }
  return hits;
}
