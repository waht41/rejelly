/**
 * Pure text helpers shared by the line prompt and its keybinding handler: paste
 * sanitization (control-char stripping, binary-paste detection) and inline
 * attachment/placeholder tokens. No React, no terminal — just string in/out.
 */

const COLLAPSE_PASTE_MIN_LINES = 6;
const COLLAPSE_PASTE_MIN_CHARS = 1200;

// Without bracketed paste, a paste arrives as a burst of tiny input events
// (single characters on Windows raw-mode stdin). Fragments of one paste land
// sub-millisecond to a few ms apart; a human keystroke is ≥60ms from the next.
// 30ms cleanly separates them: sustained typing never coalesces (so it can't be
// mistaken for a paste and collapsed), while paste fragments do.
export const PASTE_COALESCE_MS = 30;

// C0 control chars (except tab/newline) and DEL corrupt terminal rendering if
// inserted verbatim — they move the cursor around instead of printing.
function isTerminalControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f;
}

export function stripControlChars(text: string): string {
  let stripped = "";
  for (const char of text) {
    if (!isTerminalControlChar(char)) {
      stripped += char;
    }
  }
  return stripped;
}

// A binary paste (e.g. pasting an image with Ctrl+V) arrives as garbage bytes:
// raw control bytes and U+FFFD replacement chars from invalid UTF-8. Neither
// appears in legitimate pasted text, so they flag "this is not text to type".
function isBinaryPasteControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0e && code <= 0x1f);
}

export function looksBinary(text: string): boolean {
  return [...text].some(isBinaryPasteControlChar) || text.includes("�");
}

export function pastedLineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length;
}

export function shouldCollapsePastedText(text: string): boolean {
  return (
    pastedLineCount(text) >= COLLAPSE_PASTE_MIN_LINES || text.length >= COLLAPSE_PASTE_MIN_CHARS
  );
}

/** A run of input fragments that arrived close enough together to be one paste. */
export interface PasteRun {
  /** Concatenated text of every fragment in the run so far. */
  text: string;
  /** Timestamp (ms) of the most recent fragment. */
  at: number;
}

export interface CoalesceResult {
  /** The run after folding in the new fragment (fresh run when the gap was too long). */
  run: PasteRun;
  /** True once the coalesced run is large enough to collapse into a placeholder. */
  collapse: boolean;
}

/**
 * Fold `fragment` into `prev` when they arrived within `windowMs`, otherwise
 * start a fresh run. Pure so the paste/typing split can be unit-tested without a
 * terminal: the caller inserts the fragment immediately (zero typing latency)
 * and, when `collapse` flips true, retroactively swaps the run for a token.
 */
export function coalescePaste(
  prev: PasteRun | null,
  fragment: string,
  now: number,
  windowMs: number,
): CoalesceResult {
  const contiguous = prev !== null && now - prev.at <= windowMs;
  const text = contiguous ? prev.text + fragment : fragment;
  return { run: { text, at: now }, collapse: shouldCollapsePastedText(text) };
}

// Attached images live inline as `[Image #N]` tokens (N = the image's 1-based
// position in selectedImages), so they read, move, and delete like normal text.
export const IMAGE_TOKEN = /\[Image #(\d+)\]/g;
export const PASTED_TEXT_TOKEN = /\[Pasted text #(\d+) \+(\d+) (lines|chars)\]/g;

// Both placeholders share one alternation so caret motion and deletion can treat
// either as a single indivisible unit without caring which kind it is. Neither
// shape can span a newline, so a token always lives inside one logical line.
const PLACEHOLDER_SOURCE = String.raw`\[Image #\d+\]|\[Pasted text #\d+ \+\d+ (?:lines|chars)\]`;
const PLACEHOLDER_TOKEN = new RegExp(PLACEHOLDER_SOURCE, "g");

/** Half-open `[start, end)` offsets of one placeholder token in the text. */
export interface TokenSpan {
  start: number;
  end: number;
}

function* tokenSpans(text: string): Generator<TokenSpan> {
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

/**
 * The placeholder span strictly containing `pos` — edges excluded, so a caret
 * resting just before or just after a token is *outside* it. Callers use this to
 * bounce the caret back out, keeping "the caret is never inside a token" an
 * invariant that the edit ops downstream rely on.
 */
export function tokenSpanAt(text: string, pos: number): TokenSpan | null {
  for (const span of tokenSpans(text)) {
    if (span.start >= pos) break;
    if (pos < span.end) return span;
  }
  return null;
}

/**
 * The placeholder span that a deletion ending at `cursor` should swallow whole:
 * one ending exactly at the caret, or (defensively) one the caret sits inside.
 */
export function tokenSpanBefore(text: string, cursor: number): TokenSpan | null {
  for (const span of tokenSpans(text)) {
    if (span.start >= cursor) break;
    if (cursor <= span.end) return span;
  }
  return null;
}

/**
 * Pull `start` back to a token boundary so a range deletion can never cut a
 * placeholder in half (word-wise deletes otherwise stop at the spaces inside
 * `[Pasted text #1 +13 lines]`).
 */
export function alignDeletionStart(text: string, start: number): number {
  return tokenSpanAt(text, start)?.start ?? start;
}

/** The `[Pasted text #N +X lines]` token ending exactly at `cursor`, if any. */
export function pastedTextTokenBefore(text: string, cursor: number): string | null {
  return text.slice(0, cursor).match(/\[Pasted text #\d+ \+\d+ (?:lines|chars)\]$/)?.[0] ?? null;
}

export function pastedTextToken(id: number, text: string): string {
  const lines = pastedLineCount(text);
  return lines > 1
    ? `[Pasted text #${id} +${lines} lines]`
    : `[Pasted text #${id} +${text.length} chars]`;
}

export function expandPastedTextTokens(
  text: string,
  pastedTexts: Array<{ id: number; text: string }>,
): string {
  const byId = new Map(pastedTexts.map((paste) => [paste.id, paste.text]));
  return text.replace(
    PASTED_TEXT_TOKEN,
    (token, rawId: string) => byId.get(Number(rawId)) ?? token,
  );
}

/** Images still referenced by a `[Image #N]` token in `text`, in first-seen order. */
export function attachedImages(text: string, images: string[]): string[] {
  const nums = [...text.matchAll(IMAGE_TOKEN)].map((m) => Number(m[1]));
  return [...new Set(nums)].map((n) => images[n - 1]).filter((p): p is string => Boolean(p));
}
