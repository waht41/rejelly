/**
 * `@`-trigger parsing for the file picker, caret-aware: the active token is the
 * `@word` immediately to the left of the caret. A token is only "active" while
 * it is still being typed — once whitespace follows (e.g. an inserted `@path`
 * ref), it is finalized and must not re-open the picker on itself.
 */

import type { BufferState } from "./textBuffer";

/**
 * Return the query after the `@` token the caret currently sits at the end of,
 * or `null` if there is no active trigger. The `@` must start the text or follow
 * whitespace; no whitespace may sit between `@` and the caret; and the caret must
 * be at end-of-line/text (not in the middle of a finalized word).
 */
export function extractAtQuery(text: string, cursor: number): string | null {
  const left = text.slice(0, cursor);
  const at = left.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  if (at > 0 && left[at - 1] !== " " && left[at - 1] !== "\n") {
    return null;
  }
  const token = left.slice(at + 1);
  if (/\s/.test(token)) {
    return null;
  }
  // Caret must close the token: at end of text or before whitespace.
  if (cursor < text.length && !/\s/.test(text[cursor])) {
    return null;
  }
  return token;
}

/** Paths not already referenced as `@path` anywhere in the text. */
export function refsMissingFromText(text: string, paths: string[]): string[] {
  return paths.filter((path) => !text.includes(`@${path}`));
}

/**
 * Replace the active `@token` (the one ending at the caret) with `@path` refs and
 * return the new buffer state. A trailing space is kept so the inserted ref is a
 * closed token and the caret is ready for more typing. With no paths the token is
 * simply removed (used to dismiss the picker).
 */
export function replaceAtToken(state: BufferState, paths: string[]): BufferState {
  const { text, cursor } = state;
  const left = text.slice(0, cursor);
  const at = left.lastIndexOf("@");
  if (at === -1) {
    return state;
  }
  const before = text.slice(0, at);
  const after = text.slice(cursor);
  const refs = paths.map((path) => `@${path}`).join(" ");
  if (!refs) {
    return { text: before + after, cursor: before.length };
  }
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const insert = needsSpace ? `${refs} ` : refs;
  return { text: before + insert + after, cursor: before.length + insert.length };
}
