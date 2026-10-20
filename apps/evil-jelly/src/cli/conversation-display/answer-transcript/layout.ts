import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

export interface AnswerAnchor {
  line: number;
  offset: number;
}

export interface AnswerRow extends AnswerAnchor {
  text: string;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Plain source only: strip terminal controls, not Markdown; copying still uses the original. */
export function answerDisplayText(text: string): string {
  return (
    stripAnsi(text)
      .replace(/\r\n?/g, "\n")
      // Keep newlines and tabs, but do not let stored output control the terminal.
      .replace(/\p{Cc}/gu, (character) =>
        character === "\n" || character === "\t" ? character : "",
      )
  );
}

/** Layout once per answer/width. Anchors refer to source lines, never visual row numbers. */
export function layoutAnswer(text: string, columns: number): AnswerRow[] {
  const width = Math.max(1, columns);
  const rows: AnswerRow[] = [];
  for (const [line, source] of answerDisplayText(text).split("\n").entries()) {
    let row = "";
    let cells = 0;
    let logicalCells = 0;
    let sourceOffset = 0;
    let start = 0;
    for (const part of graphemes.segment(source)) {
      // Tab stops belong to the logical line, not the viewport width. Anchors use
      // expanded-source offsets so even a tab spanning multiple rows is addressable.
      const segments =
        part.segment === "\t" ? Array<string>(4 - (logicalCells % 4)).fill(" ") : [part.segment];
      for (const segment of segments) {
        const size = stringWidth(segment);
        if (cells > 0 && cells + size > width) {
          rows.push({ text: row, line, offset: start });
          row = "";
          cells = 0;
          start = sourceOffset;
        }
        // A two-cell glyph cannot fit in a one-column terminal. Never split a grapheme.
        row += size > width ? "�" : segment;
        cells += Math.min(size, width);
        logicalCells += size;
        sourceOffset += segment.length;
      }
    }
    rows.push({ text: row, line, offset: start });
  }
  return rows;
}

/** A question preview never consumes more than two visual rows of the answer reader. */
export function layoutPromptSummary(text: string, columns: number): string[] {
  const rows = layoutAnswer(`You: ${text}`, columns).map((row) => row.text);
  if (rows.length <= 2) return rows;
  const hint = columns >= 24 ? "… · p full question" : columns >= 5 ? "… · p" : "…";
  const available = Math.max(0, columns - stringWidth(hint));
  const tail = available > 0 ? layoutAnswer(rows[1]!, available)[0]!.text : "";
  return [rows[0]!, `${tail}${hint}`];
}

export function answerAnchorRow(rows: readonly AnswerRow[], anchor: AnswerAnchor): number {
  let found = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.line > anchor.line || (row.line === anchor.line && row.offset > anchor.offset)) break;
    found = index;
  }
  return found;
}
