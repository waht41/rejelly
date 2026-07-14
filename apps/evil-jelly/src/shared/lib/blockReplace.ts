/**
 * Fuzzy block locate: exact substring first, then line-trim equality (indent-tolerant).
 */

import { normalizeNewlines } from "./string";

export type BlockMatch =
  | { ok: true; start: number; end: number; mode: "exact" | "line_trim"; normalizedContent: string }
  | { ok: false; reason: string };

/** LF haystack only: leading spaces/tabs from `start` until first non-whitespace or newline. */
function leadingWhitespacePrefix(hay: string, start: number): string {
  let i = start;
  while (i < hay.length) {
    const c = hay[i];
    if (c === "\n") {
      break;
    }
    if (c !== " " && c !== "\t") {
      break;
    }
    i++;
  }
  return hay.slice(start, i);
}

/**
 * For line_trim replacements: strip common leading whitespace from replacement lines, then prefix each
 * non-empty line with the matched region's first-line indentation so agent snippets without indent do not flatten code.
 */
function indentReplacementForLineTrim(replacement: string, leadingWs: string): string {
  const lines = replacement.split("\n");
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const m = /^[ \t]*/.exec(line);
    const len = m ? m[0].length : 0;
    minIndent = Math.min(minIndent, len);
  }
  if (minIndent === Infinity) {
    minIndent = 0;
  }
  return lines
    .map((line) => {
      if (line.trim().length === 0) {
        return "";
      }
      return leadingWs + line.slice(minIndent);
    })
    .join("\n");
}

/**
 * Normalize replacement and, for line_trim matches, re-apply the first matched line's leading whitespace.
 */
export function replacementForBlockMatch(
  match: Extract<BlockMatch, { ok: true }>,
  hay: string,
  replaceBlock: string,
): string {
  const n = normalizeNewlines(replaceBlock);
  if (match.mode !== "line_trim") {
    return n;
  }
  const leading = leadingWhitespacePrefix(hay, match.start);
  return indentReplacementForLineTrim(n, leading);
}

function findAllIndices(haystack: string, needle: string): number[] {
  if (needle.length === 0) {
    return [];
  }
  const indices: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) {
      break;
    }
    indices.push(i);
    pos = i + 1;
  }
  return indices;
}

/**
 * Find contiguous line ranges where each line matches needle lines after trim().
 * Returns exclusive [start, end) byte offsets into `hay`.
 *
 * Leading/trailing blank lines in the needle are ignored, so a stray trailing newline
 * or surrounding blank line in the agent's searchBlock does not force a byte-exact retry.
 */
function findLineTrimMatchOffsets(hay: string, needle: string): { start: number; end: number }[] {
  const hayLines = hay.split("\n");
  const allNeedleLines = needle.split("\n");

  let lo = 0;
  let hi = allNeedleLines.length - 1;
  while (lo <= hi && allNeedleLines[lo].trim().length === 0) {
    lo++;
  }
  while (hi >= lo && allNeedleLines[hi].trim().length === 0) {
    hi--;
  }
  if (lo > hi) {
    return [];
  }
  const needleLines = allNeedleLines.slice(lo, hi + 1);

  const ranges: { start: number; end: number }[] = [];
  const maxI = hayLines.length - needleLines.length;
  for (let i = 0; i <= maxI; i++) {
    let match = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (hayLines[i + j]?.trim() !== needleLines[j]?.trim()) {
        match = false;
        break;
      }
    }
    if (!match) {
      continue;
    }

    let start = 0;
    for (let k = 0; k < i; k++) {
      start += hayLines[k].length + 1;
    }
    let end = start;
    for (let k = 0; k < needleLines.length; k++) {
      end += hayLines[i + k].length;
      if (k < needleLines.length - 1) {
        end += 1;
      }
    }
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * Locate the span in `fileContent` that should be replaced by `replaceBlock`.
 * Prefers a unique exact match; otherwise a unique line-trim match.
 *
 * Indices are always offsets into `normalizedContent` (LF-only). Callers must slice that string, not raw CRLF input.
 */
export function findBlockToReplace(fileContent: string, searchBlock: string): BlockMatch {
  const hay = normalizeNewlines(fileContent);
  const needle = normalizeNewlines(searchBlock);

  const exactIdxs = findAllIndices(hay, needle);
  if (exactIdxs.length === 1) {
    const s = exactIdxs[0];
    return {
      ok: true,
      start: s,
      end: s + needle.length,
      mode: "exact",
      normalizedContent: hay,
    };
  }
  if (exactIdxs.length > 1) {
    return {
      ok: false,
      reason: `searchBlock matches ${exactIdxs.length} times exactly; narrow the snippet or add surrounding lines.`,
    };
  }

  const trimRanges = findLineTrimMatchOffsets(hay, needle);
  if (trimRanges.length === 1) {
    const m = trimRanges[0];
    return { ok: true, start: m.start, end: m.end, mode: "line_trim", normalizedContent: hay };
  }
  if (trimRanges.length > 1) {
    return {
      ok: false,
      reason: `After line-trim comparison, searchBlock matches ${trimRanges.length} regions; add more unique context lines.`,
    };
  }

  return {
    ok: false,
    reason:
      "searchBlock not found in file. Copy a contiguous chunk from read_file output (exact or same lines after trim).",
  };
}

/**
 * Apply ordered search/replace edits in memory.
 *
 * Sentinels (trimmed `searchBlock`):
 * - Empty → whole-document replace with `replaceBlock` for that step.
 * - `"@head"` → prepend `replaceBlock` at file start (virtual anchor; not matched as substring).
 * - `"@end"` → append `replaceBlock` at file end (virtual anchor).
 *
 * Each step normalizes CRLF→LF. Match offsets are always applied to `normalizedContent` returned from findBlockToReplace.
 * `searchBlock` / `replaceBlock` are normalized inside helpers; locate uses normalizeNewlines on both sides.
 */
export function applyBlockEdits(
  fileContent: string,
  edits: { searchBlock: string; replaceBlock: string }[],
): { ok: true; text: string } | { ok: false; reason: string; failedIndex: number } {
  let updated = normalizeNewlines(fileContent);
  let i = 0;
  for (const edit of edits) {
    const trimmedSearch = edit.searchBlock.trim();
    const replacement = normalizeNewlines(edit.replaceBlock);

    if (trimmedSearch === "") {
      updated = replacement;
      i++;
      continue;
    }

    if (trimmedSearch === "@head") {
      const padding = replacement.endsWith("\n") || updated.startsWith("\n") ? "" : "\n";
      updated = replacement + padding + updated;
      i++;
      continue;
    }

    if (trimmedSearch === "@end") {
      const padding = updated.endsWith("\n") || replacement.startsWith("\n") ? "" : "\n";
      updated = updated + padding + replacement;
      i++;
      continue;
    }

    const match = findBlockToReplace(updated, edit.searchBlock);
    if (!match.ok) {
      return { ok: false, reason: match.reason, failedIndex: i };
    }
    const hay = match.normalizedContent;
    const merged = replacementForBlockMatch(match, hay, edit.replaceBlock);
    const before = hay.slice(0, match.start);
    const after = hay.slice(match.end);
    updated = before + merged + after;
    i++;
  }
  return { ok: true, text: updated };
}
