import type { DOMElement } from "ink";
import { useCursor } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { recordComposerCommit } from "../composerProfiler";
import type { CaretAffinity, WrappedRow } from "./softWrap";
import { caretCell, wrapRows } from "./softWrap";

export interface PromptLayout {
  rowRef: React.RefObject<DOMElement | null>;
  /** Complete wrap shared with editing/navigation; the viewport never changes the draft. */
  rows: WrappedRow[];
  visibleRows: WrappedRow[];
}

function absoluteOrigin(node: DOMElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: DOMElement | undefined = node;
  while (current) {
    x += current.yogaNode?.getComputedLeft() ?? 0;
    y += current.yogaNode?.getComputedTop() ?? 0;
    current = current.parentNode;
  }
  return { x, y };
}

export function usePromptLayout({
  text,
  cursor,
  caretAffinity,
  active = true,
  label,
  columns,
  maxRows,
}: {
  text: string;
  cursor: number;
  caretAffinity: CaretAffinity;
  active?: boolean;
  label: string;
  columns: number;
  maxRows: number;
}): PromptLayout {
  const { setCursorPosition } = useCursor();
  const rowRef = useRef<DOMElement>(null);
  const [, setMounted] = useState(false);
  const labelWidth = stringWidth(`${label || "❯"} `);
  const rows = wrapRows(text, Math.max(1, columns - labelWidth));
  const caret = caretCell(rows, cursor, caretAffinity);
  const visibleStart = Math.max(0, caret.row - Math.max(1, maxRows) + 1);
  const visibleRows = rows.slice(visibleStart, visibleStart + Math.max(1, maxRows));

  // Ink resolves this after the CURRENT Yoga layout, immediately before painting.
  // Caching an absolute origin in React state paints one frame with the previous
  // layout's caret whenever tool/context/stream rows above the editor change.
  setCursorPosition(() => {
    const row = rowRef.current;
    if (!active || !row?.yogaNode) return undefined;
    // A raw resize can paint before React receives the new width. Do not position
    // a caret using a wrap that no longer describes this row's layout.
    if (row.yogaNode.getComputedWidth() !== columns) return undefined;
    const origin = absoluteOrigin(row);
    const position = {
      x: Math.min(origin.x + labelWidth + caret.col, origin.x + columns - 1),
      y: origin.y + caret.row - visibleStart,
    };
    let current: DOMElement | undefined = row;
    while (current) {
      if (current.style.display === "none") return undefined;
      const clip = current.nodeName === "ink-root" || current.style.overflow === "hidden";
      if (clip && current.yogaNode) {
        const bounds = absoluteOrigin(current);
        if (
          position.x < bounds.x ||
          position.x >= bounds.x + current.yogaNode.getComputedWidth() ||
          position.y < bounds.y ||
          position.y >= bounds.y + current.yogaNode.getComputedHeight()
        )
          return undefined;
      }
      current = current.parentNode;
    }
    return position;
  });

  // Refs attach after Ink's initial paint. Request one safe follow-up paint to
  // show the caret; subsequent positions need no measurement/state round trip.
  useLayoutEffect(() => setMounted(true), []);
  useLayoutEffect(() => {
    recordComposerCommit(cursor, text.length, rows.length);
  });

  return { rowRef, rows, visibleRows };
}
