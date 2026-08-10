/**
 * Pure flat-string editing operations plus a rich document-backed React buffer.
 * The hook projects semantic tokens to display text for legacy transforms while
 * keeping its canonical caret in logical coordinates, where a token has length 1.
 */

import { useMemo, useState } from "react";
import {
  documentLogicalLength,
  type ProjectedTokenSpan,
  type ProjectionBias,
  type PromptDocument,
  type PromptNode,
  projectPromptDocument,
  replacePromptRange,
  textPromptDocument,
} from "./promptDocument";

export interface BufferState {
  text: string;
  /** Caret offset into `text`, always in [0, text.length]. */
  cursor: number;
}

export interface RichBufferState {
  readonly document: PromptDocument;
  /** Logical offset: a text code unit and an entire semantic token both occupy one position. */
  readonly cursor: number;
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

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (length < limit && left[left.length - length - 1] === right[right.length - length - 1]) {
    length += 1;
  }
  return length;
}

/**
 * Compatibility bridge for existing plain-text transforms. The transform sees the display
 * projection; edits touching any part of a semantic token expand to that token's logical range.
 */
export function applyProjectedTransform(
  state: RichBufferState,
  transform: (state: BufferState) => BufferState,
  cursorBias: ProjectionBias = "nearest",
): RichBufferState {
  const projection = projectPromptDocument(state.document);
  const displayCursor = projection.logicalToDisplay(state.cursor);
  const transformed = transform({ text: projection.text, cursor: displayCursor });

  if (transformed.text === projection.text) {
    return {
      document: state.document,
      cursor: projection.displayToLogical(transformed.cursor, cursorBias),
    };
  }

  const prefixLength = commonPrefixLength(projection.text, transformed.text);
  const suffixLength = commonSuffixLength(projection.text, transformed.text, prefixLength);
  const oldEndDisplay = projection.text.length - suffixLength;
  const newEndDisplay = transformed.text.length - suffixLength;
  const startLogical = projection.displayToLogical(prefixLength, "left");
  const endLogical = projection.displayToLogical(oldEndDisplay, "right");
  const insertedText = transformed.text.slice(prefixLength, newEndDisplay);
  const insertedNodes: PromptNode[] = insertedText ? [{ type: "text", text: insertedText }] : [];
  const document = replacePromptRange(state.document, startLogical, endLogical, insertedNodes);

  let cursor: number;
  if (transformed.cursor <= prefixLength) {
    cursor =
      transformed.cursor === prefixLength
        ? startLogical
        : projection.displayToLogical(transformed.cursor, "left");
  } else if (transformed.cursor <= newEndDisplay) {
    cursor = startLogical + transformed.cursor - prefixLength;
  } else {
    const oldDisplayCursor = oldEndDisplay + transformed.cursor - newEndDisplay;
    const oldLogicalCursor = projection.displayToLogical(oldDisplayCursor, "right");
    cursor = startLogical + insertedText.length + Math.max(0, oldLogicalCursor - endLogical);
  }

  return { document, cursor: clamp(cursor, 0, documentLogicalLength(document)) };
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
  /** Run a legacy display-text transform through the rich-document compatibility projection. */
  apply: (fn: (s: BufferState) => BufferState, cursorBias?: ProjectionBias) => void;
  /** Replace a display-text range with rich nodes and put the caret after the insertion. */
  replaceDisplayRange: (start: number, end: number, nodes: readonly PromptNode[]) => void;
  /** Replace the whole text; caret defaults to end. */
  setText: (text: string, cursor?: number) => void;
  setDocument: (document: PromptDocument, cursor?: number) => void;
  reset: () => void;
}

export interface TextBuffer extends BufferState, TextBufferActions {
  readonly document: PromptDocument;
  readonly logicalCursor: number;
  readonly tokenSpans: readonly ProjectedTokenSpan[];
}

export function useTextBuffer(initial = ""): TextBuffer {
  const [state, setState] = useState<RichBufferState>({
    document: textPromptDocument(initial),
    cursor: initial.length,
  });

  // Actions are stable (functional updates only), so they are safe to list in
  // effect/callback deps without retriggering on every keystroke.
  const actions = useMemo<TextBufferActions>(
    () => ({
      insert: (str) =>
        setState((current) => ({
          document: replacePromptRange(current.document, current.cursor, current.cursor, [
            { type: "text", text: str },
          ]),
          cursor: current.cursor + str.length,
        })),
      deleteForward: () => setState((current) => applyProjectedTransform(current, deleteForward)),
      deleteToLineStart: () =>
        setState((current) => applyProjectedTransform(current, deleteToLineStart)),
      moveLineStart: () => setState((current) => applyProjectedTransform(current, moveLineStart)),
      moveLineEnd: () => setState((current) => applyProjectedTransform(current, moveLineEnd)),
      apply: (fn, cursorBias) =>
        setState((current) => applyProjectedTransform(current, fn, cursorBias)),
      replaceDisplayRange: (start, end, nodes) =>
        setState((current) => {
          const projection = projectPromptDocument(current.document);
          const logicalStart = projection.displayToLogical(start, "left");
          const logicalEnd = projection.displayToLogical(end, "right");
          const document = replacePromptRange(current.document, logicalStart, logicalEnd, nodes);
          const insertedLength = nodes.reduce(
            (length, node) => length + (node.type === "text" ? node.text.length : 1),
            0,
          );
          return { document, cursor: logicalStart + insertedLength };
        }),
      setText: (text, cursor) =>
        setState({
          document: textPromptDocument(text),
          cursor: clamp(cursor ?? text.length, 0, text.length),
        }),
      setDocument: (document, cursor) =>
        setState({
          document,
          cursor: clamp(
            cursor ?? documentLogicalLength(document),
            0,
            documentLogicalLength(document),
          ),
        }),
      reset: () => setState({ document: [], cursor: 0 }),
    }),
    [],
  );

  const projection = projectPromptDocument(state.document);
  return {
    document: state.document,
    logicalCursor: state.cursor,
    tokenSpans: projection.tokenSpans,
    text: projection.text,
    cursor: projection.logicalToDisplay(state.cursor),
    ...actions,
  };
}
