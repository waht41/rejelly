import wrapAnsi from "wrap-ansi";
import { normalizeNewlines } from "../../../shared/foundation/string";
import {
  markdownHeadingStyle,
  markdownListItemIndent,
  markdownListItemPrefix,
  markdownTableLayout,
  markdownTableRowHeight,
  splitStreamingMarkdown,
} from "./MarkdownViewer";
import { parseMarkdownBlocks } from "./markdownParser";

const MIN_COLUMNS = 1;
const QUOTE_OUTER_PADDING_COLUMNS = 1;
const QUOTE_LEVEL_CHROME_COLUMNS = 2;

export type StreamTailWindow = {
  text: string;
  clipped: boolean;
  forceRaw: boolean;
  measuredRows: number;
};

function safeColumns(columns: number): number {
  return Math.max(MIN_COLUMNS, Math.floor(columns) || MIN_COLUMNS);
}

/**
 * Count the rows `text` occupies once wrapped to `columns`.
 *
 * `wordWrap` must mirror the ink `wrap` prop the same text is rendered with, or
 * the window budget drifts from what the terminal shows: ink's default `wrap`
 * breaks on word boundaries (`wordWrap: true`), while `wrap="hard"` breaks
 * strictly at the column (`wordWrap: false`). Word wrapping can need *more*
 * rows than hard wrapping — "ab cdefghijkl" at 10 columns is 3 rows, not 2 —
 * so measuring with the wrong mode silently overflows the budget.
 */
export function measureWrappedRows(
  text: string,
  columns: number,
  { wordWrap = true }: { wordWrap?: boolean } = {},
): number {
  if (text.length === 0) {
    return 0;
  }
  const wrapped = wrapAnsi(normalizeNewlines(text), safeColumns(columns), {
    hard: true,
    trim: false,
    wordWrap,
  });
  return Math.max(1, wrapped.split("\n").length);
}

function measureMarkdownStableRows(markdown: string, columns: number): number {
  const blocks = parseMarkdownBlocks(markdown);
  let rows = 0;

  for (const [index, block] of blocks.entries()) {
    const marginTop = index === 0 ? 0 : 1;
    if (block.type === "heading") {
      // The level glyph shares the title's line, so it competes for the same
      // columns; the h1 rule occupies a line of its own.
      const style = markdownHeadingStyle(block.depth);
      rows +=
        marginTop +
        measureWrappedRows(`${style.prefix}${block.text}`, columns) +
        (style.rule ? 1 : 0);
      continue;
    }
    if (block.type === "paragraph") {
      rows += marginTop + measureWrappedRows(block.text, columns);
      continue;
    }
    if (block.type === "list") {
      // The marker and the nesting indent both eat into the text column, and
      // they vary per item ("- " vs "10. ", depth 0 vs depth 2), so budget each
      // item against what the renderer actually leaves it.
      rows +=
        marginTop +
        block.items.reduce((total, item) => {
          const chrome = markdownListItemIndent(item) + markdownListItemPrefix(item).length;
          return total + measureWrappedRows(item.text, Math.max(1, columns - chrome));
        }, 0);
      continue;
    }
    if (block.type === "table") {
      const { mode, widths } = markdownTableLayout(block, columns);
      if (mode === "records") {
        const valueColumns = Math.max(1, columns - 1);
        const recordRows = block.rows.reduce((total, row, rowIndex) => {
          const cellRows = widths.reduce((cellTotal, _, columnIndex) => {
            const label = block.headers[columnIndex] || `Column ${columnIndex + 1}`;
            const value = row[columnIndex] ?? "";
            return (
              cellTotal +
              Math.max(1, measureWrappedRows(label, columns)) +
              Math.max(1, measureWrappedRows(value, valueColumns))
            );
          }, 0);
          return total + (rowIndex > 0 ? 1 : 0) + cellRows;
        }, 0);
        rows += marginTop + recordRows;
        continue;
      }

      // Column mode has one heavy header rule, plus a light separator between
      // logical body rows. Cell content is already wrapped to its column width.
      const tableRows =
        1 +
        markdownTableRowHeight(block.headers, widths) +
        Math.max(0, block.rows.length - 1) +
        block.rows.reduce((total, row) => total + markdownTableRowHeight(row, widths), 0);
      rows += marginTop + tableRows;
      continue;
    }
    if (block.type === "quote") {
      rows +=
        marginTop +
        block.lines.reduce((total, line) => {
          const quoteColumns = Math.max(
            1,
            columns - QUOTE_OUTER_PADDING_COLUMNS - line.depth * QUOTE_LEVEL_CHROME_COLUMNS,
          );
          return total + Math.max(1, measureWrappedRows(line.text, quoteColumns));
        }, 0);
      continue;
    }
    if (block.type === "code") {
      const codeRows =
        block.lines.length > 0
          ? block.lines.reduce(
              (total, line) =>
                total + Math.max(1, measureWrappedRows(line, columns, { wordWrap: false })),
              0,
            )
          : 1;
      rows += marginTop + codeRows;
      continue;
    }
    rows += marginTop + 1;
  }

  return rows;
}

export function measureStreamRows(text: string, columns: number): number {
  if (text.length === 0) {
    return 0;
  }

  const { stable, tail } = splitStreamingMarkdown(text);
  return (
    (stable.trim().length > 0 ? measureMarkdownStableRows(stable, columns) : 0) +
    (tail.length > 0 ? measureWrappedRows(tail, columns) : 0)
  );
}

function visuallyClipSuffix(text: string, columns: number, maxRows: number): string {
  // The clipped suffix is rendered raw (`<Text>{...}</Text>`, ink's default
  // `wrap`), so it has to be split the same way ink would split it.
  const wrappedLines = wrapAnsi(normalizeNewlines(text), safeColumns(columns), {
    hard: true,
    trim: false,
  }).split("\n");
  return wrappedLines.slice(-maxRows).join("\n");
}

export function createStreamTailWindow({
  text,
  columns,
  maxRows,
}: {
  text: string;
  columns: number;
  maxRows: number;
}): StreamTailWindow {
  const normalized = normalizeNewlines(text);
  const rowBudget = Math.max(0, Math.floor(maxRows));
  if (normalized.length === 0 || rowBudget <= 0) {
    return { text: "", clipped: normalized.length > 0, forceRaw: true, measuredRows: 0 };
  }

  const fullRows = measureStreamRows(normalized, columns);
  if (fullRows <= rowBudget) {
    return { text: normalized, clipped: false, forceRaw: false, measuredRows: fullRows };
  }

  const lines = normalized.split("\n");
  let bestStart = lines.length;
  let low = 0;
  let high = lines.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = lines.slice(mid).join("\n");
    const rows = measureStreamRows(candidate, columns);
    if (rows <= rowBudget) {
      bestStart = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (bestStart < lines.length) {
    const candidate = lines.slice(bestStart).join("\n");
    return {
      text: candidate,
      clipped: true,
      forceRaw: false,
      measuredRows: measureStreamRows(candidate, columns),
    };
  }

  const clippedText = visuallyClipSuffix(normalized, columns, rowBudget);
  return {
    text: clippedText,
    clipped: true,
    forceRaw: true,
    measuredRows: measureWrappedRows(clippedText, columns),
  };
}
