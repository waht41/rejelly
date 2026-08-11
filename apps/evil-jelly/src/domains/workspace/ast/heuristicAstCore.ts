/**
 * Stateless AST heuristics via @ast-grep/napi (LSP-style shortcuts without a language server).
 * Workspace parse/read only; import symbols, paths, and limits from sibling modules.
 */

import { type Lang, parse, type SgNode } from "@ast-grep/napi";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import { MAX_HEURISTIC_AST_BYTES } from "../source/heuristicAstLimits";
import { AST_SCRIPT_EXTENSIONS, tryLangFromRelPath } from "../source/sourceLanguage";

/** Bounded read + ast-grep parse for one workspace-relative script path. */
export type ParsedWorkspaceAst = {
  rel: string;
  text: string;
  root: SgNode;
  lang: Lang;
};

export type ParseWorkspaceAstOptions = {
  /**
   * Error wording when parse() throws.
   * - withRel: `Failed to parse <rel>: <message>` (default, matches single-file AST tools)
   * - minimal: `Parse failed: <message>`
   */
  parseErrorStyle?: "withRel" | "minimal";
};

export async function readBoundedSource(
  rel: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const policy = getWorkspaceFsPolicy();
  try {
    const stat = await policy.stat(rel);
    if (stat.size > MAX_HEURISTIC_AST_BYTES) {
      return {
        ok: false,
        error: `File too large for AST scan (${stat.size} bytes; max ${MAX_HEURISTIC_AST_BYTES}).`,
      };
    }
    const text = await policy.readAstFile(rel);
    return { ok: true, text };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function parseWorkspaceRelToAst(
  rel: string,
  options?: ParseWorkspaceAstOptions,
): Promise<(ParsedWorkspaceAst & { ok: true }) | { ok: false; error: string }> {
  const src = await readBoundedSource(rel);
  if (!src.ok) {
    return { ok: false, error: src.error };
  }
  const lang = tryLangFromRelPath(rel);
  if (!lang) {
    return {
      ok: false,
      error:
        `Unsupported file extension for AST scan: ${rel}. ` +
        `ast_* tools currently support JS/TS files (${AST_SCRIPT_EXTENSIONS.join(", ")}).`,
    };
  }
  try {
    const root = parse(lang, src.text).root();
    return { ok: true, rel, text: src.text, root, lang };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const style = options?.parseErrorStyle ?? "withRel";
    const error = style === "minimal" ? `Parse failed: ${msg}` : `Failed to parse ${rel}: ${msg}`;
    return { ok: false, error };
  }
}

/** Same as parseWorkspaceRelToAst but returns null on read or parse failure (workspace scans). */
export async function tryParseWorkspaceRel(rel: string): Promise<ParsedWorkspaceAst | null> {
  const r = await parseWorkspaceRelToAst(rel);
  if (!r.ok) {
    return null;
  }
  return { rel: r.rel, text: r.text, root: r.root, lang: r.lang };
}
