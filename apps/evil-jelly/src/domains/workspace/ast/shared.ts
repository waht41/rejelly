/**
 * Shared helpers for heuristic AST tool services (parse, workspace declaration scan, dependency expansion).
 */

import type { Lang, SgNode } from "@ast-grep/napi";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import { MAX_HEURISTIC_RESULTS } from "../source/heuristicAstLimits";
import { langFromRelPath } from "../source/sourceLanguage";
import { listWorkspaceScriptRelPaths, tryResolveRelativeImport } from "../source/workspacePaths";
import {
  type ParseWorkspaceAstOptions,
  parseWorkspaceRelToAst,
  tryParseWorkspaceRel,
} from "./heuristicAstCore";
import { extractJsDocAbove } from "./jsdoc";
import {
  collectDocumentSymbols,
  extractExternalCalleeSymbols,
  extractNamedImportModuleForSymbol,
  filterDeclarationsByName,
  findCallableDeclarationForSymbol,
  findNamedDeclarationAstNodes,
  getCallableEnvelope,
  type HeuristicSymbolRow,
  pickOutlineDeclaration,
  sliceDeclarationSignature,
} from "./queries";

export const MAX_OUTPUT_CHARS = 45_000;

export const identifierSafe = /^[A-Za-z_$][\w$]*$/;

export function truncateJson(obj: unknown): string {
  const raw = JSON.stringify(obj, null, 2);
  if (raw.length <= MAX_OUTPUT_CHARS) {
    return raw;
  }
  return `${raw.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, max ${MAX_OUTPUT_CHARS} chars)`;
}

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
  const resolved = getWorkspaceFsPolicy().tryResolve(filePath);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  return parseWorkspaceRelToAst(resolved.rel, options);
}

export type DeclHit = HeuristicSymbolRow & { file: string };

export async function collectMatchingDeclarations(
  symbolName: string,
  caseInsensitive: boolean,
): Promise<DeclHit[]> {
  const files = await listWorkspaceScriptRelPaths();
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
      hits.push({ ...row, file: rel });
      if (hits.length >= MAX_HEURISTIC_RESULTS) {
        break outer;
      }
    }
  }
  return hits;
}

export const MAX_DEPENDENCY_ROWS_TOTAL = 80;
export const MAX_JSDOC_CHARS = 200;

export function normalizeJsDocForDeps(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const stripped = raw
    .replace(/^\/\*\*|\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim()
    .replace(/\s+/g, " ");
  if (stripped.length <= MAX_JSDOC_CHARS) {
    return stripped;
  }
  return `${stripped.slice(0, MAX_JSDOC_CHARS)}…`;
}

export type DependencyJsonRow = {
  name: string;
  definedIn: string | null;
  declarationLine: number | null;
  signature: string | null;
  jsDoc: string | null;
  unresolved?: boolean;
  nested?: DependencyJsonRow[];
};

export async function resolveOutlineDeclarationNode(
  symbolName: string,
  hintRel: string,
  hintSrc: string,
  hintRoot: SgNode,
): Promise<{ rel: string; src: string; root: SgNode; decl: SgNode } | null> {
  const lang = langFromRelPath(hintRel);
  /* Prefer imported definitions before same-file outline declarations (avoids alias/shadow collisions). */
  const importSpec = extractNamedImportModuleForSymbol(hintSrc, lang, symbolName);
  if (importSpec) {
    const targetRel = await tryResolveRelativeImport(hintRel, importSpec);
    if (targetRel) {
      const parsed = await parseWorkspaceRelToAst(targetRel);
      if (parsed.ok) {
        const picked = pickOutlineDeclaration(
          findNamedDeclarationAstNodes(parsed.root, symbolName, false, parsed.lang),
        );
        if (picked) {
          return {
            rel: targetRel,
            src: parsed.text,
            root: parsed.root,
            decl: picked,
          };
        }
      }
    }
  }
  let picked = pickOutlineDeclaration(
    findNamedDeclarationAstNodes(hintRoot, symbolName, false, lang),
  );
  if (picked) {
    return { rel: hintRel, src: hintSrc, root: hintRoot, decl: picked };
  }
  const hits = await collectMatchingDeclarations(symbolName, false);
  for (const h of hits.slice(0, 16)) {
    const parsed = await tryParseWorkspaceRel(h.file);
    if (!parsed) {
      continue;
    }
    picked = pickOutlineDeclaration(
      findNamedDeclarationAstNodes(parsed.root, symbolName, false, parsed.lang),
    );
    if (picked) {
      return { rel: h.file, src: parsed.text, root: parsed.root, decl: picked };
    }
  }
  return null;
}

export function formatDependencyRow(
  decl: SgNode,
  src: string,
  rel: string,
  name: string,
): DependencyJsonRow {
  const lines = src.split(/\r?\n/);
  const line = decl.range().start.line + 1;
  const raw = extractJsDocAbove(lines, line);
  return {
    name,
    definedIn: rel.replace(/\\/g, "/"),
    declarationLine: line,
    signature: sliceDeclarationSignature(src, decl),
    jsDoc: normalizeJsDocForDeps(raw) ?? null,
  };
}

export function extractCalleeNamesFromEnvelope(envelope: SgNode, lang: Lang): string[] {
  const body = envelope.field("body");
  if (!body) {
    return [];
  }
  return extractExternalCalleeSymbols(body, lang);
}

export async function expandDependencyRow(
  symbolName: string,
  hintRel: string,
  hintSrc: string,
  hintRoot: SgNode,
  depthRemaining: number,
  visited: Set<string>,
  budget: { left: number },
): Promise<DependencyJsonRow | null> {
  if (budget.left <= 0) {
    return null;
  }
  if (visited.has(symbolName)) {
    return null;
  }
  visited.add(symbolName);
  const resolved = await resolveOutlineDeclarationNode(symbolName, hintRel, hintSrc, hintRoot);
  if (!resolved) {
    budget.left--;
    return {
      name: symbolName,
      definedIn: null,
      declarationLine: null,
      signature: null,
      jsDoc: null,
      unresolved: true,
    };
  }
  const { rel, src, root, decl } = resolved;
  const row = formatDependencyRow(decl, src, rel, symbolName);
  budget.left--;
  if (depthRemaining <= 1 || budget.left <= 0) {
    return row;
  }
  const callableDecl = findCallableDeclarationForSymbol(root, symbolName, false);
  const envelope = callableDecl ? getCallableEnvelope(callableDecl) : undefined;
  if (!envelope) {
    return row;
  }
  const calleeNames = extractCalleeNamesFromEnvelope(envelope, langFromRelPath(rel));
  const nested: DependencyJsonRow[] = [];
  for (const callee of calleeNames) {
    if (budget.left <= 0) {
      break;
    }
    const child = await expandDependencyRow(
      callee,
      rel,
      src,
      root,
      depthRemaining - 1,
      visited,
      budget,
    );
    if (child) {
      nested.push(child);
    }
  }
  if (nested.length > 0) {
    row.nested = nested;
  }
  return row;
}
