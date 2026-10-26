import { parse, type SgNode } from "@ast-grep/napi";
import { getAgentFileAccess } from "../../../domains/workspace/file-access/agentFileAccess";
import { MAX_HEURISTIC_AST_BYTES } from "../../../domains/workspace/source/heuristicAstLimits";
import {
  langFromRelPath,
  tryLangFromRelPath,
} from "../../../domains/workspace/source/sourceLanguage";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";

export function tryParseRoot(file: string, code: string): SgNode | null {
  try {
    return parse(langFromRelPath(file), code).root();
  } catch {
    return null;
  }
}

/** Bounded, policy-gated source parsing for audit scans; unreadable or unsupported files are skipped. */
export async function tryParseWorkspaceRel(rel: string) {
  try {
    const resolved = getAgentFileAccess().tryResolve(rel, { kind: "read" }, "normal");
    if (!resolved.ok) {
      return null;
    }
    const policy = getWorkspaceFiles();
    const stat = await policy.statResolved(resolved);
    if (stat.size > MAX_HEURISTIC_AST_BYTES) {
      return null;
    }
    const lang = tryLangFromRelPath(rel);
    if (!lang) {
      return null;
    }
    const text = await policy.readResolved(resolved);
    const root = parse(lang, text).root();
    return { rel, text, root, lang };
  } catch {
    return null;
  }
}
