/**
 * Placeholder-aware caret motion and deletion.
 *
 * `[Image #N]` and `[Pasted text #N +X lines]` are single characters as far as
 * the user is concerned, but in the buffer they are 10–30 ordinary chars. Left
 * unguarded, an arrow key parks the caret mid-token and the next keystroke
 * corrupts it — and a corrupted token stops matching its regex, so the pasted
 * body is never expanded and the image is never attached: the content vanishes
 * silently on submit.
 *
 * The fix is one invariant — *the caret is never strictly inside a token* —
 * upheld by snapping every motion out to the nearer edge, plus deletions that
 * swallow a whole token rather than nibbling its tail. This module remains the
 * compatibility policy for legacy placeholders in the rich buffer's text projection.
 */

import {
  type BufferState,
  backspace,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  wordLeft,
} from "../document/textBuffer";
import { alignDeletionStart, tokenSpanAt, tokenSpanBefore } from "../placeholderText";

/** Which edge to bounce to when a motion lands the caret inside a token. */
export type SnapDirection = "left" | "right" | "nearest";

export function snapCaretOutOfPlaceholder(s: BufferState, dir: SnapDirection): BufferState {
  const span = tokenSpanAt(s.text, s.cursor);
  if (!span) {
    return s;
  }
  if (dir === "nearest") {
    const toStart = s.cursor - span.start <= span.end - s.cursor;
    return { ...s, cursor: toStart ? span.start : span.end };
  }
  return { ...s, cursor: dir === "left" ? span.start : span.end };
}

// A caret leaving a token keeps travelling in the direction it was headed, so a
// single arrow press steps over the whole placeholder. Line start/end need no
// guard: a token never contains a newline, so those offsets are always outside.
export const caretLeft = (s: BufferState): BufferState =>
  snapCaretOutOfPlaceholder(moveLeft(s), "left");
export const caretRight = (s: BufferState): BufferState =>
  snapCaretOutOfPlaceholder(moveRight(s), "right");
export const caretWordLeft = (s: BufferState): BufferState =>
  snapCaretOutOfPlaceholder(moveWordLeft(s), "left");
export const caretWordRight = (s: BufferState): BufferState =>
  snapCaretOutOfPlaceholder(moveWordRight(s), "right");

// Vertical motion has no horizontal intent, so it settles on whichever edge of
// the token the preserved column landed closer to.
export const caretUp = (s: BufferState): BufferState =>
  snapCaretOutOfPlaceholder(moveUp(s), "nearest");
export const caretDown = (s: BufferState): BufferState =>
  snapCaretOutOfPlaceholder(moveDown(s), "nearest");

function cut(s: BufferState, start: number, end: number): BufferState {
  return { text: s.text.slice(0, start) + s.text.slice(end), cursor: start };
}

/** Backspace, but a placeholder touching the caret goes in one stroke. */
export function deletePlaceholderOrChar(s: BufferState): BufferState {
  const span = tokenSpanBefore(s.text, s.cursor);
  return span ? cut(s, span.start, span.end) : backspace(s);
}

/**
 * Delete-word-left that can't shear a token: it takes the whole placeholder when
 * one ends at the caret, and otherwise pulls the word boundary out of any token
 * it happens to land in (`+13 lines]` is three "words" to `wordLeft`).
 */
export function deleteWordLeftAtomic(s: BufferState): BufferState {
  const span = tokenSpanBefore(s.text, s.cursor);
  if (span) {
    return cut(s, span.start, span.end);
  }
  const start = alignDeletionStart(s.text, wordLeft(s.text, s.cursor));
  return start === s.cursor ? s : cut(s, start, s.cursor);
}
