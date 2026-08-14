/**
 * `@`-trigger parsing for the file picker, caret-aware: the active token is the
 * `@word` immediately to the left of the caret. A token is only "active" while
 * it is still being typed. A committed selection becomes a semantic file token,
 * so this parser never reconstructs file identity from display text.
 */

import type { BufferState } from "../../editor/document/textBuffer";

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

export function activeAtTrigger(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const query = extractAtQuery(text, cursor);
  return query === null ? null : { start: cursor - query.length - 1, end: cursor, query };
}

/** Remove the unfinished text trigger when the picker is dismissed. */
export function removeActiveAtTrigger(state: BufferState): BufferState {
  const { text, cursor } = state;
  const left = text.slice(0, cursor);
  const at = left.lastIndexOf("@");
  if (at === -1) {
    return state;
  }
  const before = text.slice(0, at);
  const after = text.slice(cursor);
  return { text: before + after, cursor: before.length };
}
