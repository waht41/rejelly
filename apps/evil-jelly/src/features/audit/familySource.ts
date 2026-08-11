/**
 * Source helpers shared by audit seed families. This module owns the mechanical parts that new
 * families are likely to reuse: cached file snapshots, line-range slicing, token normalization, and
 * fenced source blocks. Family-specific identity rules and prompts stay in the family files.
 */

import { parse, type SgNode } from "@ast-grep/napi";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import { langFromRelPath } from "../../shared/lib/path";
import type { NormalizedToken } from "./detectors/clone";
import { tokenizeNormalized } from "./detectors/clone/tokenize";

const FENCE_LANG: Record<string, string> = {
  TypeScript: "ts",
  Tsx: "tsx",
  JavaScript: "js",
};

export interface AuditSourceRange {
  startLine: number;
  endLine: number;
}

export interface AuditSourceSnapshot {
  lines: string[];
  tokens: NormalizedToken[] | null;
}

export type AuditSourceSnapshotReader = (file: string) => Promise<AuditSourceSnapshot>;

export function compareString(a: string, b: string): number {
  return a.localeCompare(b);
}

export function normalizeAuditSourceFallback(source: string): string {
  return source
    .replace(/\b[$A-Z_a-z][$\w]*\b/g, "$ID")
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "$LIT")
    .replace(/\b\d+(?:\.\d+)?\b/g, "$LIT")
    .replace(/\s+/g, " ")
    .trim();
}

export function sliceAuditSourceLines(lines: string[], range: AuditSourceRange): string {
  const start = Math.max(1, range.startLine);
  const end = Math.min(lines.length, range.endLine);
  return lines.slice(start - 1, end).join("\n");
}

export function tokensInLineRange(tokens: NormalizedToken[], range: AuditSourceRange): string {
  return tokens
    .filter((token) => token.line >= range.startLine && token.line <= range.endLine)
    .map((token) => token.norm)
    .join(" ");
}

async function readSnapshot(file: string): Promise<AuditSourceSnapshot> {
  const policy = getWorkspaceFsPolicy();
  const source = await policy.readFile(file);
  let root: SgNode | null = null;
  try {
    root = parse(langFromRelPath(file), source).root();
  } catch {
    root = null;
  }
  return {
    lines: source.split(/\r?\n/),
    tokens: root ? tokenizeNormalized(root) : null,
  };
}

/** Create a per-run snapshot reader so family identity adapters do not repeatedly read/parse files. */
export function createAuditSourceSnapshotReader(): AuditSourceSnapshotReader {
  const snapshots = new Map<string, Promise<AuditSourceSnapshot>>();

  return (file: string): Promise<AuditSourceSnapshot> => {
    const existing = snapshots.get(file);
    if (existing) {
      return existing;
    }
    const created = readSnapshot(file).catch(() => ({ lines: [], tokens: null }));
    snapshots.set(file, created);
    return created;
  };
}

export async function readCappedLineSlice(
  file: string,
  range: AuditSourceRange,
  maxLines: number,
): Promise<string | null> {
  const policy = getWorkspaceFsPolicy();
  try {
    const text = await policy.readFile(file);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, range.startLine);
    const end = Math.min(lines.length, range.endLine);
    const slice = lines.slice(start - 1, Math.min(end, start - 1 + maxLines));
    const truncated = end - start + 1 > maxLines ? "\n… (truncated)" : "";
    return slice.join("\n") + truncated;
  } catch {
    return null;
  }
}

export function fencedCodeBlock(file: string, source: string): string {
  const lang = FENCE_LANG[langFromRelPath(file)] ?? "";
  return `\`\`\`${lang}\n${source}\n\`\`\``;
}
