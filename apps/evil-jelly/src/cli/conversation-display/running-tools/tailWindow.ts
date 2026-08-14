/**
 * The shared tail window: one fixed-height view of what the running tools are
 * printing right now.
 *
 * Live shell output is transient by design — it never reaches `<Static>`, so it
 * never lands in scrollback. What survives a tool call is its collapsed block;
 * this window only answers "is it still alive, and where is it".
 *
 * Deliberately *not* `concurrently`: that tool interleaves every process into
 * one stream in arrival order, which works because its output scrolls into an
 * infinite backlog. Here the window is a handful of rows and is the only view,
 * so arrival order would let one chatty command evict a quiet one within a
 * frame — and the evicted line is gone for good. Instead each tool keeps its own
 * buffer and the window is composed by handing out rows round-robin, so every
 * running tool stays visible. Rows are grouped by tool rather than interleaved:
 * in six rows, two contiguous runs read far better than a shuffle.
 *
 * Pure: no React, no store, no terminal.
 */

import { stripVTControlCharacters } from "node:util";

/** Longer than any terminal is wide; the row is truncated again at render. */
const MAX_LINE_CHARS = 512;

/**
 * A carriage return means the shell was overwriting the line in place (progress
 * bars, spinners). Only the last segment was ever visible.
 */
function collapseCarriageReturns(text: string): string {
  const lastReturn = text.lastIndexOf("\r");
  return lastReturn === -1 ? text : text.slice(lastReturn + 1);
}

function capLength(text: string): string {
  return text.length <= MAX_LINE_CHARS ? text : text.slice(0, MAX_LINE_CHARS);
}

/** Clean one raw line for display: overwrite semantics, then colors, then width. */
export function toDisplayLine(raw: string): string {
  return capLength(stripVTControlCharacters(collapseCarriageReturns(raw)).trimEnd());
}

export interface ToolOutputDrain {
  /** Complete lines, cleaned for display, oldest first. Blank lines are dropped. */
  lines: string[];
  /**
   * The still-unterminated remainder, kept raw so a VT sequence split across two
   * chunks reassembles. Collapsed and capped, so appending to it forever (a
   * progress bar that never emits a newline) cannot grow without bound.
   */
  rest: string;
}

/**
 * Pull every complete line out of an accumulated chunk buffer. Callers append
 * raw chunks to `rest` and drain again — chunk boundaries fall wherever the OS
 * pipe decided, so a line is only complete once its `\n` has actually arrived.
 */
export function drainToolOutput(buffer: string): ToolOutputDrain {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const segments = normalized.split("\n");
  const rest = segments.pop() ?? "";
  const lines: string[] = [];

  for (const segment of segments) {
    const line = toDisplayLine(segment);
    // A blank row is pure loss in a window this small.
    if (line.length > 0) {
      lines.push(line);
    }
  }

  return { lines, rest: capLength(collapseCarriageReturns(rest)) };
}

export interface RunningToolTail {
  /** The tool call's display number, also its prefix in a shared window. */
  ordinal: number;
  /** Complete lines, oldest first. */
  tail: string[];
  /** Raw unterminated remainder, shown provisionally as the newest row. */
  partial: string;
}

export interface TailRow {
  ordinal: number;
  text: string;
}

function rowsOf(tool: RunningToolTail): string[] {
  const partial = toDisplayLine(tool.partial);
  return partial.length > 0 ? [...tool.tail, partial] : tool.tail;
}

/**
 * Fill `maxRows` from the running tools, newest rows first within each tool.
 *
 * Rows are handed out one at a time in ordinal order and the pass repeats until
 * the window is full or nothing is left — which gives every tool an equal share
 * and then spends the remainder on whoever still has output, without a separate
 * redistribution step. A single running tool therefore gets the whole window,
 * and the result reads exactly like a plain tail.
 */
export function composeToolTailWindow(tools: RunningToolTail[], maxRows: number): TailRow[] {
  if (maxRows <= 0) {
    return [];
  }

  const candidates = tools
    .map((tool) => ({ ordinal: tool.ordinal, rows: rowsOf(tool) }))
    .filter((candidate) => candidate.rows.length > 0)
    .sort((a, b) => a.ordinal - b.ordinal);
  if (candidates.length === 0) {
    return [];
  }

  const quotas = new Array<number>(candidates.length).fill(0);
  let remaining = maxRows;
  let handedOut = true;
  while (remaining > 0 && handedOut) {
    handedOut = false;
    for (let i = 0; i < candidates.length && remaining > 0; i++) {
      if (quotas[i]! < candidates[i]!.rows.length) {
        quotas[i]!++;
        remaining--;
        handedOut = true;
      }
    }
  }

  const window: TailRow[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const quota = quotas[i]!;
    for (const text of candidate.rows.slice(candidate.rows.length - quota)) {
      window.push({ ordinal: candidate.ordinal, text });
    }
  }
  return window;
}
