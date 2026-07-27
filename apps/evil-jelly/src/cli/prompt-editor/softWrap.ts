/**
 * Soft-wrap layout for the line prompt: turns the flat buffer into the physical
 * rows the terminal actually shows, and maps a caret offset onto one of them.
 *
 * The prompt paints its own wrap instead of letting Ink do it. Ink wraps inside
 * `renderNodeToOutput` at a width that is not observable from a component (the
 * per-line `<Text>` node's `getMaxWidth()`), so anything the caret math derived
 * on its own would only *approximate* the frame. Pre-wrapping here makes the
 * rendered rows and the caret's row/column read from the same list — the caret
 * can no longer disagree with what is on screen.
 *
 * Wrapping matches Ink's own call (`wrap-ansi`, `trim: false, hard: true`), so
 * the visual result is unchanged from letting Ink wrap. Pure: no React, no
 * terminal, just text and a width in.
 */

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

export interface WrappedRow {
  /** The row's text, exactly as it slices out of the buffer. */
  text: string;
  /** Offset into the buffer of this row's first character. */
  start: number;
}

/**
 * Split `text` into the rows a `width`-wide box renders it as. Logical lines
 * (`\n`) always start a row; longer ones are soft-wrapped on top of that.
 * A width of 0 or less means "not measured yet" — every logical line stays one
 * row, which is what an unwrapped first frame paints anyway.
 */
export function wrapRows(text: string, width: number): WrappedRow[] {
  const rows: WrappedRow[] = [];
  let start = 0;

  for (const line of text.split("\n")) {
    // `wrap-ansi` with `trim: false` is loss-free — the segments concatenate
    // back to `line`, which is what lets `start` stay an exact buffer offset.
    const segments =
      width > 0 && stringWidth(line) > width
        ? wrapAnsi(line, width, { trim: false, hard: true }).split("\n")
        : [line];
    for (const segment of segments) {
      rows.push({ text: segment, start });
      start += segment.length;
    }
    start += 1; // the "\n" that ended this logical line
  }

  return rows;
}

/**
 * Row index and column (in terminal cells) where `cursor` is drawn.
 *
 * A caret sitting exactly on a wrap boundary belongs to the *following* row:
 * that offset is where the next typed character lands, and after the re-wrap it
 * shows up as that row's first character.
 */
export function caretCell(rows: WrappedRow[], cursor: number): { row: number; col: number } {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || cursor < row.start) {
      continue;
    }
    return { row: i, col: stringWidth(row.text.slice(0, cursor - row.start)) };
  }
  return { row: 0, col: 0 };
}
