import type { DOMElement } from "ink";
import { useCursor } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import type { CaretAffinity, WrappedRow } from "./softWrap";
import { caretCell, wrapRows } from "./softWrap";

interface TextArea {
  x: number;
  y: number;
  width: number;
}

export interface PromptLayout {
  /** Stable label+text row measured after Ink completes Yoga layout. */
  rowRef: React.RefObject<DOMElement | null>;
  /** One shared wrap used by rendering, caret placement, and vertical movement. */
  rows: WrappedRow[];
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
  label,
}: {
  text: string;
  cursor: number;
  caretAffinity: CaretAffinity;
  label: string;
}): PromptLayout {
  const { setCursorPosition } = useCursor();
  const rowRef = useRef<DOMElement>(null);
  const [textArea, setTextArea] = useState<TextArea | null>(null);
  const labelWidth = stringWidth(`${label || "❯"} `);
  const rows = wrapRows(text, textArea?.width ?? 0);
  const caret = caretCell(rows, cursor, caretAffinity);

  setCursorPosition(
    textArea
      ? { x: textArea.x + caret.col, y: textArea.y + caret.row }
      : // The first frame has not been measured, so there is no honest caret position yet.
        undefined,
  );

  // Ink completes Yoga layout before layout effects. Measure after every commit
  // because attachments and status rows above the editor can move its absolute
  // origin without changing any of this hook's direct inputs.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const origin = absoluteOrigin(row);
    const next: TextArea = {
      x: origin.x + labelWidth,
      y: origin.y,
      width: (row.yogaNode?.getComputedWidth() ?? 0) - labelWidth,
    };
    setTextArea((previous) =>
      previous?.x === next.x && previous.y === next.y && previous.width === next.width
        ? previous
        : next,
    );
  });

  return { rowRef, rows };
}
