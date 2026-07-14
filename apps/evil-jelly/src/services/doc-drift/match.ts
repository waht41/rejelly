/**
 * Deterministic section→symbol matching for doc-drift validation (INV-0015). Candidate identifiers
 * come from headings and inline code spans; fenced example code contributes to *matching* only
 * (examples legitimately reference APIs) but never to the unmatched-mention list (examples are full
 * of local variables that would drown it in noise).
 */

import type { MarkdownSection } from "./sections";

/** Structurally mirrors services/ast SurfaceSymbol (services stay siblings; the feature composes). */
export interface MatchableSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  jsdoc?: string;
}

export interface SectionSymbolMatch {
  /** Surface symbols referenced by this section (deduped, document order of first mention). */
  matched: MatchableSymbol[];
  /** Identifiers mentioned in headings/inline code with no surface hit (noise-filtered). */
  unmatched: string[];
}

const IDENTIFIER_RE = /[$A-Za-z_][$\w]*/g;

/** Identifier-ish tokens; short tokens (`z`, `fn`, `id`) are dropped as noise. */
function identifierTokens(text: string): string[] {
  const tokens = text.match(IDENTIFIER_RE) ?? [];
  return tokens.filter((t) => t.length >= 3);
}

interface SectionMentions {
  /** From headings + inline code spans: match and report when missing. */
  primary: string[];
  /** From fenced example code: match only, never reported as unmatched. */
  secondary: string[];
}

/** Extract identifier mentions from one section, fence-aware. */
export function extractSectionMentions(section: MarkdownSection): SectionMentions {
  const primary: string[] = [];
  const secondary: string[] = [];
  const seenPrimary = new Set<string>();
  const seenSecondary = new Set<string>();
  const pushAll = (tokens: string[], into: string[], seen: Set<string>) => {
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        into.push(token);
      }
    }
  };

  pushAll(identifierTokens(section.heading), primary, seenPrimary);

  let inFence = false;
  let fenceMarker = "";
  for (const line of section.text.split(/\r?\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      pushAll(identifierTokens(line), secondary, seenSecondary);
      continue;
    }
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      pushAll(identifierTokens(span[1]), primary, seenPrimary);
    }
  }
  return { primary, secondary };
}

/** Index a surface symbol list by exact name. */
export function buildSymbolTable(symbols: MatchableSymbol[]): Map<string, MatchableSymbol[]> {
  const table = new Map<string, MatchableSymbol[]>();
  for (const symbol of symbols) {
    const bucket = table.get(symbol.name);
    if (bucket) {
      bucket.push(symbol);
    } else {
      table.set(symbol.name, [symbol]);
    }
  }
  return table;
}

/** Match one section's mentions against the surface table. */
export function matchSectionSymbols(
  section: MarkdownSection,
  table: Map<string, MatchableSymbol[]>,
): SectionSymbolMatch {
  const { primary, secondary } = extractSectionMentions(section);
  const matched: MatchableSymbol[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];

  const tryMatch = (name: string): boolean => {
    const hits = table.get(name);
    if (!hits) {
      return false;
    }
    for (const hit of hits) {
      const key = `${hit.file}:${hit.line}:${hit.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        matched.push(hit);
      }
    }
    return true;
  };

  for (const name of primary) {
    if (!tryMatch(name)) {
      unmatched.push(name);
    }
  }
  for (const name of secondary) {
    tryMatch(name);
  }
  return { matched, unmatched };
}
