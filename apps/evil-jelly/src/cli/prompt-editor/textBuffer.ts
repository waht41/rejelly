/**
 * A flat-string text buffer with a single caret offset. Newlines live in the
 * string, so the same model serves single- and multi-line editing; callers
 * derive rows/cols for rendering. All ops are pure and clamp the caret, so the
 * state can never point outside the text.
 */

import { useMemo, useState } from "react";

export interface BufferState {
  text: string;
  /** Caret offset into `text`, always in [0, text.length]. */
  cursor: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/** Offset of the first char on the line containing `pos`. */
export function lineStart(text: string, pos: number): number {
  const nl = text.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Offset just past the last char on the line containing `pos` (the `\n`, or end). */
export function lineEnd(text: string, pos: number): number {
  const nl = text.indexOf("\n", pos);
  return nl === -1 ? text.length : nl;
}

/** Start offset of the word to the left of `pos` (skip whitespace, then word). */
export function wordLeft(text: string, pos: number): number {
  let i = clamp(pos, 0, text.length);
  while (i > 0 && isSpace(text[i - 1])) i--;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  return i;
}

/** End offset of the word to the right of `pos` (skip whitespace, then word). */
export function wordRight(text: string, pos: number): number {
  let i = clamp(pos, 0, text.length);
  while (i < text.length && isSpace(text[i])) i++;
  while (i < text.length && !isSpace(text[i])) i++;
  return i;
}

export function insert(s: BufferState, str: string): BufferState {
  const cursor = clamp(s.cursor, 0, s.text.length);
  const text = s.text.slice(0, cursor) + str + s.text.slice(cursor);
  return { text, cursor: cursor + str.length };
}

export function backspace(s: BufferState): BufferState {
  const cursor = clamp(s.cursor, 0, s.text.length);
  if (cursor === 0) return s;
  return { text: s.text.slice(0, cursor - 1) + s.text.slice(cursor), cursor: cursor - 1 };
}

export function deleteForward(s: BufferState): BufferState {
  const cursor = clamp(s.cursor, 0, s.text.length);
  if (cursor >= s.text.length) return s;
  return { text: s.text.slice(0, cursor) + s.text.slice(cursor + 1), cursor };
}

export function deleteWordLeft(s: BufferState): BufferState {
  const cursor = clamp(s.cursor, 0, s.text.length);
  const start = wordLeft(s.text, cursor);
  if (start === cursor) return s;
  return { text: s.text.slice(0, start) + s.text.slice(cursor), cursor: start };
}

export function deleteToLineStart(s: BufferState): BufferState {
  const cursor = clamp(s.cursor, 0, s.text.length);
  const start = lineStart(s.text, cursor);
  if (start === cursor) return s;
  return { text: s.text.slice(0, start) + s.text.slice(cursor), cursor: start };
}

export function moveLeft(s: BufferState): BufferState {
  return { ...s, cursor: clamp(s.cursor - 1, 0, s.text.length) };
}

export function moveRight(s: BufferState): BufferState {
  return { ...s, cursor: clamp(s.cursor + 1, 0, s.text.length) };
}

export function moveWordLeft(s: BufferState): BufferState {
  return { ...s, cursor: wordLeft(s.text, s.cursor) };
}

export function moveWordRight(s: BufferState): BufferState {
  return { ...s, cursor: wordRight(s.text, s.cursor) };
}

export function moveLineStart(s: BufferState): BufferState {
  return { ...s, cursor: lineStart(s.text, s.cursor) };
}

export function moveLineEnd(s: BufferState): BufferState {
  return { ...s, cursor: lineEnd(s.text, s.cursor) };
}

export function moveUp(s: BufferState): BufferState {
  const start = lineStart(s.text, s.cursor);
  if (start === 0) return { ...s, cursor: 0 };
  const col = s.cursor - start;
  const prevStart = lineStart(s.text, start - 1);
  const prevLen = start - 1 - prevStart;
  return { ...s, cursor: prevStart + Math.min(col, prevLen) };
}

export function moveDown(s: BufferState): BufferState {
  const end = lineEnd(s.text, s.cursor);
  if (end === s.text.length) return { ...s, cursor: s.text.length };
  const col = s.cursor - lineStart(s.text, s.cursor);
  const nextStart = end + 1;
  const nextLen = lineEnd(s.text, nextStart) - nextStart;
  return { ...s, cursor: nextStart + Math.min(col, nextLen) };
}

/** Row (0-based line index) and column of the caret, for rendering. */
export function cursorRowCol(text: string, cursor: number): { row: number; col: number } {
  const before = text.slice(0, clamp(cursor, 0, text.length));
  const lastNl = before.lastIndexOf("\n");
  const row = before.length === 0 ? 0 : (before.match(/\n/g)?.length ?? 0);
  return { row, col: before.length - (lastNl + 1) };
}

/**
 * Only the ops that are safe to fire blind are bound as actions. The char- and
 * word-wise motions and deletes above are deliberately absent: the prompt wraps
 * them in `placeholderMotion` so the caret can't come to rest inside an inline
 * `[Image #N]` / `[Pasted text #N …]` token, and a raw action here would be a
 * way to bypass that. Reach them through `apply` with a composed transform.
 */
export interface TextBufferActions {
  insert: (str: string) => void;
  deleteForward: () => void;
  deleteToLineStart: () => void;
  moveLineStart: () => void;
  moveLineEnd: () => void;
  /** Run an arbitrary pure transform against the current state. */
  apply: (fn: (s: BufferState) => BufferState) => void;
  /** Replace the whole text; caret defaults to end. */
  setText: (text: string, cursor?: number) => void;
  reset: () => void;
}

export type TextBuffer = BufferState & TextBufferActions;

export function useTextBuffer(initial = ""): TextBuffer {
  const [state, setState] = useState<BufferState>({ text: initial, cursor: initial.length });

  // Actions are stable (functional updates only), so they are safe to list in
  // effect/callback deps without retriggering on every keystroke.
  const actions = useMemo<TextBufferActions>(
    () => ({
      insert: (str) => setState((s) => insert(s, str)),
      deleteForward: () => setState(deleteForward),
      deleteToLineStart: () => setState(deleteToLineStart),
      moveLineStart: () => setState(moveLineStart),
      moveLineEnd: () => setState(moveLineEnd),
      apply: (fn) => setState(fn),
      setText: (text, cursor) =>
        setState({ text, cursor: clamp(cursor ?? text.length, 0, text.length) }),
      reset: () => setState({ text: "", cursor: 0 }),
    }),
    [],
  );

  return { text: state.text, cursor: state.cursor, ...actions };
}
