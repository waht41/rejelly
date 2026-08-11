/**
 * Exported-symbol surface extraction (INV-0015): the deterministic "API surface snapshot" used by
 * doc-drift validation. For each script file, list module-outline declarations that are exported,
 * with their declaration signature and attached JSDoc. Zero LLM; bounded by the heuristic-AST caps.
 */

import type { SgNode } from "@ast-grep/napi";
import { tryParseWorkspaceRel } from "../../../domains/workspace/ast/heuristicAstCore";
import { extractJsDocAbove } from "../../../domains/workspace/ast/jsdoc";
import type { HeuristicSymbolKind } from "../../../domains/workspace/ast/queries";
import {
  collectOutlineDeclarations,
  sliceDeclarationSignature,
} from "../../../domains/workspace/ast/queries";
import { tryParseRoot } from "../../../shared/lib/ast-parse";
import { isTestOrGeneratedPath, langFromRelPath } from "../../../shared/lib/path";

export interface SurfaceSymbol {
  name: string;
  kind: HeuristicSymbolKind;
  /** Workspace-relative posix path. */
  file: string;
  /** 1-based declaration line. */
  line: number;
  /** Declaration head up to the body / initializer (e.g. `export function foo(a: string): Bar`). */
  signature: string;
  jsdoc?: string;
}

export interface SurfaceExtraction {
  /** Sorted by file, then line, then name — stable for downstream hashing. */
  symbols: SurfaceSymbol[];
  filesScanned: number;
  filesParsed: number;
}

/** Whether a declaration node sits under an `export` statement (directly or via its declaration list). */
function isExportedDeclaration(node: SgNode): boolean {
  let cur: SgNode | null | undefined = node.parent();
  while (cur) {
    const k = cur.kind();
    if (k === "export_statement") {
      return true;
    }
    if (k === "program") {
      return false;
    }
    cur = cur.parent();
  }
  return false;
}

/** Extract the exported surface of one parsed source. */
export function extractSurfaceFromParsed(
  file: string,
  text: string,
  root: SgNode,
): SurfaceSymbol[] {
  const lines = text.split(/\r?\n/);
  const out: SurfaceSymbol[] = [];
  for (const decl of collectOutlineDeclarations(root, langFromRelPath(file))) {
    if (!isExportedDeclaration(decl.node)) {
      continue;
    }
    const line = decl.node.range().start.line + 1;
    // Interfaces carry their doc-relevant facts in the members, not the head; keep the full body
    // (docs claim member names/types, and member edits must invalidate dependent doc sections).
    const signature =
      decl.kind === "interface"
        ? decl.node.text().trim()
        : sliceDeclarationSignature(text, decl.node);
    if (!signature) {
      continue;
    }
    const jsdoc = extractJsDocAbove(lines, line);
    out.push({
      name: decl.name,
      kind: decl.kind,
      file,
      line,
      signature,
      ...(jsdoc !== undefined ? { jsdoc } : {}),
    });
  }
  return out;
}

/** In-memory variant (IO-free) — for tests and callers that already hold content. */
export function extractSurfaceFromSource(file: string, code: string): SurfaceSymbol[] {
  const root = tryParseRoot(file, code);
  if (!root) {
    return [];
  }
  return extractSurfaceFromParsed(file, code, root);
}

/**
 * Extract the exported surface across the given workspace-relative script files.
 * Test/generated files are skipped; unreadable or unparsable files are silently dropped.
 */
export async function extractExportedSurface(files: string[]): Promise<SurfaceExtraction> {
  const symbols: SurfaceSymbol[] = [];
  let filesParsed = 0;
  for (const rel of files) {
    if (isTestOrGeneratedPath(rel)) {
      continue;
    }
    const parsed = await tryParseWorkspaceRel(rel);
    if (!parsed) {
      continue;
    }
    filesParsed++;
    symbols.push(...extractSurfaceFromParsed(rel, parsed.text, parsed.root));
  }
  symbols.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name),
  );
  return { symbols, filesScanned: files.length, filesParsed };
}
