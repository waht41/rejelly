import { link as terminalLink } from "ansi-escapes";
import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { normalizeNewlines } from "../../../shared/lib/string";

type MarkdownBlock =
  | { type: "heading"; depth: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] }
  | { type: "quote"; lines: string[] }
  | { type: "code"; language?: string; lines: string[] }
  | { type: "rule" };

type TableAlignment = "left" | "center" | "right";

const MAX_RENDER_BLOCKS = 500;
const MIN_TABLE_COLUMN_WIDTH = 3;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const URL_TRAILING_PUNCTUATION = ".,;:!?";
const URL_CLOSING_PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") {
      return true;
    }
  }
  return false;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseTableSeparator(line: string): TableAlignment[] | null {
  if (!hasUnescapedPipe(line)) {
    return null;
  }
  const cells = splitTableRow(line);
  if (cells.length === 0) {
    return null;
  }
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell.replace(/\s+/g, ""))) {
      return null;
    }
    const compact = cell.replace(/\s+/g, "");
    if (compact.startsWith(":") && compact.endsWith(":")) {
      alignments.push("center");
    } else if (compact.endsWith(":")) {
      alignments.push("right");
    } else {
      alignments.push("left");
    }
  }
  return alignments;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const separator = lines[index + 1] ?? "";
  return hasUnescapedPipe(header) && parseTableSeparator(separator) !== null;
}

function isBlockStart(line: string): boolean {
  if (line.trim() === "") {
    return true;
  }
  return (
    isFence(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s{0,3}>\s?/.test(line) ||
    /^\s{0,3}([-*+])\s+/.test(line) ||
    /^\s{0,3}\d+[.)]\s+/.test(line) ||
    /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
  );
}

function isIncompleteStreamingBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+$/.test(line) || /^\s{0,3}[-*+]\s+$/.test(line) || /^\s{0,3}\d+[.)]\s+$/.test(line)
  );
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = normalizeNewlines(markdown).split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```\s*([^\s`]*)?/);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) {
        i++;
      }
      blocks.push({
        type: "code",
        language: fence[1] || undefined,
        lines: codeLines,
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", depth: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i] ?? "");
      const alignments = parseTableSeparator(lines[i + 1] ?? "") ?? [];
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && hasUnescapedPipe(lines[i] ?? "") && lines[i]?.trim() !== "") {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ type: "table", headers, alignments, rows });
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const match = (lines[i] ?? "").match(/^\s{0,3}>\s?(.*)$/);
        if (!match) {
          break;
        }
        quoteLines.push(match[1]);
        i++;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    const listMatch = line.match(/^\s{0,3}(?:([-*+])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = listMatch[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const match = (lines[i] ?? "").match(/^\s{0,3}(?:([-*+])|(\d+)[.)])\s+(.+)$/);
        if (!match || (match[2] !== undefined) !== ordered) {
          break;
        }
        let item = match[3].trim();
        i++;
        while (i < lines.length) {
          const continuation = lines[i] ?? "";
          if (continuation.trim() === "") {
            break;
          }
          if (isBlockStart(continuation)) {
            break;
          }
          item += ` ${continuation.trim()}`;
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    const startIndex = i;
    while (i < lines.length && !isBlockStart(lines[i] ?? "")) {
      paragraph.push((lines[i] ?? "").trim());
      i++;
    }
    if (i === startIndex) {
      paragraph.push(line.trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(withTerminalLinks(text.slice(lastIndex, start)));
    }
    if (value.startsWith("`")) {
      nodes.push(
        <Text key={`${keyPrefix}-code-${index++}`} color="cyan">
          {withTerminalLinks(value.slice(1, -1))}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`${keyPrefix}-bold-${index++}`} bold>
          {value.slice(2, -2)}
        </Text>,
      );
    }
    lastIndex = start + value.length;
  }

  if (lastIndex < text.length) {
    nodes.push(withTerminalLinks(text.slice(lastIndex)));
  }

  return nodes;
}

function countOccurrences(text: string, character: string): number {
  let total = 0;
  for (const candidate of text) {
    if (candidate === character) {
      total++;
    }
  }
  return total;
}

// A bare URL has no closing delimiter, so the match has to guess where it ends.
// Prose and code both routinely park a URL in front of sentence punctuation or
// inside brackets — `see https://x/a.` and `(https://x/a)` — and those trailing
// characters belong to the surrounding text, not to the link target. Brackets
// are only dropped when unbalanced, so wiki-style URLs that legitimately carry a
// pair (`https://x/a_(b)`) keep it.
function trimUrlBoundary(url: string): string {
  let candidate = url;

  while (candidate.length > 0) {
    const last = candidate.at(-1) ?? "";
    if (URL_TRAILING_PUNCTUATION.includes(last)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    const opening = URL_CLOSING_PAIRS[last];
    if (opening && countOccurrences(candidate, last) > countOccurrences(candidate, opening)) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    break;
  }

  return candidate;
}

/**
 * Wrap every bare URL in an OSC 8 hyperlink so it stays clickable after layout.
 *
 * Terminals only auto-detect URLs inside a single unbroken line, so anything we
 * wrap or truncate loses its link; the escape carries the full target through
 * both. Apply this to a whole logical line *before* handing it to wrap-ansi —
 * wrap-ansi re-opens the hyperlink on each wrapped row, whereas linking
 * pre-wrapped fragments would point each row at a truncated URL.
 */
function withTerminalLinks(text: string): string {
  let rendered = "";
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrlBoundary(match[0]);
    rendered += text.slice(lastIndex, start);
    try {
      rendered += terminalLink(url, new URL(url).href);
    } catch {
      rendered += url;
    }
    lastIndex = start + url.length;
  }

  return rendered + text.slice(lastIndex);
}

export function markdownInlineText(text: string): string {
  return text.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
}

// Must measure with the same string-width used by wrap-ansi and ink, or the
// column layout, per-line padding, and actual wrapping disagree and the table
// borders drift. East-Asian-ambiguous characters (— ± → α …) render 1 or 2
// cells depending on the host terminal; that is inherently unknowable from
// here, so we deliberately follow string-width's model (ambiguous = narrow)
// instead of second-guessing per platform.
export function terminalCellWidth(text: string): number {
  return stringWidth(text);
}

function tableCellText(cells: string[], index: number): string {
  return cells[index] ?? "";
}

function tableCellDisplayWidth(value: string): number {
  return terminalCellWidth(markdownInlineText(value));
}

export type MarkdownTableLayout = {
  widths: number[];
  renderedWidth: number;
};

function tableRenderedWidth(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0) + widths.length * 3 + 1;
}

function naturalTableWidths(block: Extract<MarkdownBlock, { type: "table" }>): number[] {
  const columnCount = Math.max(
    block.headers.length,
    block.alignments.length,
    ...block.rows.map((row) => row.length),
  );
  return Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(
      tableCellDisplayWidth(tableCellText(block.headers, columnIndex)),
      ...block.rows.map((row) => tableCellDisplayWidth(tableCellText(row, columnIndex))),
      MIN_TABLE_COLUMN_WIDTH,
    ),
  );
}

export function markdownTableLayout(
  block: Extract<MarkdownBlock, { type: "table" }>,
  columns: number,
): MarkdownTableLayout {
  const widths = naturalTableWidths(block);
  if (widths.length === 0) {
    return { widths, renderedWidth: 0 };
  }

  const safeColumns = Math.max(1, Math.floor(columns) || 1);
  const separatorWidth = widths.length * 3 + 1;
  const widthBudget = safeColumns - separatorWidth;
  if (widthBudget <= 0) {
    const minimumWidths = widths.map(() => 1);
    return { widths: minimumWidths, renderedWidth: tableRenderedWidth(minimumWidths) };
  }

  const minimumWidth =
    widthBudget >= widths.length * MIN_TABLE_COLUMN_WIDTH ? MIN_TABLE_COLUMN_WIDTH : 1;
  const minimumWidths = widths.map(() => minimumWidth);
  const minimumTotal = minimumWidths.reduce((total, width) => total + width, 0);
  const targetContentWidth = Math.max(minimumTotal, widthBudget);
  let currentContentWidth = widths.reduce((total, width) => total + width, 0);
  if (currentContentWidth <= targetContentWidth) {
    return { widths, renderedWidth: tableRenderedWidth(widths) };
  }

  const constrained = [...widths];
  while (currentContentWidth > targetContentWidth) {
    let widestIndex = -1;
    let widestExcess = 0;
    for (let index = 0; index < constrained.length; index++) {
      const excess = constrained[index]! - minimumWidths[index]!;
      if (excess > widestExcess) {
        widestExcess = excess;
        widestIndex = index;
      }
    }
    if (widestIndex === -1) {
      break;
    }
    constrained[widestIndex] -= 1;
    currentContentWidth -= 1;
  }

  return { widths: constrained, renderedWidth: tableRenderedWidth(constrained) };
}

function wrapTableCell(value: string, width: number): string[] {
  // Link before wrapping: wrap-ansi re-opens the hyperlink on every row, so a
  // URL split across cell lines keeps pointing at the whole target.
  const text = withTerminalLinks(markdownInlineText(value));
  if (text.length === 0) {
    return [""];
  }
  return wrapAnsi(text, Math.max(1, width), {
    hard: true,
    trim: false,
    wordWrap: false,
  }).split("\n");
}

function tableCellPadding(
  value: string,
  width: number,
  alignment: TableAlignment,
): { left: string; right: string } {
  // `value` is an already wrapped cell line: inline markers are gone and any URL
  // carries OSC 8 escapes, which string-width discounts. Measure it as-is
  // instead of running it through the inline pass a second time.
  const padding = Math.max(0, width - terminalCellWidth(value));
  if (alignment === "right") {
    return { left: " ".repeat(padding), right: "" };
  }
  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return { left: " ".repeat(left), right: " ".repeat(right) };
  }
  return { left: "", right: " ".repeat(padding) };
}

export function markdownTableRowHeight(cells: string[], widths: number[]): number {
  return Math.max(
    1,
    ...widths.map((width, index) => wrapTableCell(tableCellText(cells, index), width).length),
  );
}

function renderTableRowLines(
  cells: string[],
  widths: number[],
  alignments: TableAlignment[],
): ReactNode[][] {
  const cellLines = widths.map((width, index) => wrapTableCell(tableCellText(cells, index), width));
  const rowHeight = Math.max(1, ...cellLines.map((lines) => lines.length));

  return Array.from({ length: rowHeight }, (_, lineIndex) => {
    const nodes: ReactNode[] = ["│ "];
    widths.forEach((width, columnIndex) => {
      const value = cellLines[columnIndex]?.[lineIndex] ?? "";
      const padding = tableCellPadding(value, width, alignments[columnIndex] ?? "left");
      nodes.push(padding.left);
      nodes.push(value);
      nodes.push(padding.right);
      nodes.push(columnIndex === widths.length - 1 ? " │" : " │ ");
    });
    return nodes;
  });
}

function tableRule(left: string, join: string, right: string, widths: number[]): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(join)}${right}`;
}

/**
 * Split a still-streaming markdown buffer into a `stable` prefix that is safe to
 * render with {@link MarkdownViewer} and a `tail` that should stay raw until it
 * finishes forming. Keeping the in-progress structural block raw avoids the
 * paragraph→table / fence reflow "flicker" while tokens are still arriving.
 *
 * Only two cases are held back; everything else (prose, lists, headings, already
 * valid tables) renders immediately:
 *  - an unclosed code fence: from the last opening fence to the end, and
 *  - a forming table: a trailing block with pipes that is not yet a valid table.
 */
export function splitStreamingMarkdown(markdown: string): { stable: string; tail: string } {
  const normalized = normalizeNewlines(markdown);
  const lines = normalized.split("\n");

  // 1) Unclosed code fence — everything from the last opening fence is in flight.
  let openFenceIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i] ?? "")) {
      openFenceIndex = openFenceIndex === -1 ? i : -1;
    }
  }
  if (openFenceIndex !== -1) {
    return {
      stable: lines.slice(0, openFenceIndex).join("\n"),
      tail: lines.slice(openFenceIndex).join("\n"),
    };
  }

  // 2) Inspect the trailing block (the run of non-blank lines after the last blank line).
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") {
    end--;
  }
  if (end === 0) {
    return { stable: normalized, tail: "" };
  }
  let blockStart = end;
  while (blockStart > 0 && (lines[blockStart - 1] ?? "").trim() !== "") {
    blockStart--;
  }

  const blockLines = lines.slice(blockStart, end);
  if (blockLines.length === 1 && isIncompleteStreamingBlockStart(blockLines[0] ?? "")) {
    return {
      stable: lines.slice(0, blockStart).join("\n"),
      tail: lines.slice(blockStart).join("\n"),
    };
  }

  const firstLine = blockLines[0] ?? "";
  const looksTabular = !isFence(firstLine) && blockLines.some((line) => hasUnescapedPipe(line));
  if (looksTabular && !isTableStart(blockLines, 0)) {
    return {
      stable: lines.slice(0, blockStart).join("\n"),
      tail: lines.slice(blockStart).join("\n"),
    };
  }

  return { stable: normalized, tail: "" };
}

/**
 * Markdown renderer for a live stream: renders completed blocks via
 * {@link MarkdownViewer} and keeps the in-progress trailing block raw.
 */
export function StreamMarkdownViewer({ text, columns }: { text: string; columns?: number }) {
  const { stable, tail } = splitStreamingMarkdown(text);
  return (
    <Box flexDirection="column">
      {stable.trim().length > 0 ? <MarkdownViewer text={stable} columns={columns} /> : null}
      {tail.length > 0 ? <Text>{tail}</Text> : null}
    </Box>
  );
}

export function MarkdownViewer({
  text,
  columns: explicitColumns,
}: {
  text: string;
  columns?: number;
}) {
  const { columns: windowColumns } = useWindowSize();
  const columns = explicitColumns ?? windowColumns;
  const blocks = parseMarkdownBlocks(text);
  const truncated = blocks.length > MAX_RENDER_BLOCKS;
  const visibleBlocks = truncated ? blocks.slice(0, MAX_RENDER_BLOCKS) : blocks;

  return (
    <Box flexDirection="column">
      {visibleBlocks.map((block, index) => {
        const key = `${index}:${block.type}`;
        if (block.type === "heading") {
          return (
            <Box key={key} marginTop={index === 0 ? 0 : 1}>
              <Text bold color={block.depth <= 2 ? "cyanBright" : "cyan"} wrap="wrap">
                {renderInline(block.text, key)}
              </Text>
            </Box>
          );
        }
        if (block.type === "paragraph") {
          return (
            <Box key={key} marginTop={index === 0 ? 0 : 1}>
              <Text wrap="wrap">{renderInline(block.text, key)}</Text>
            </Box>
          );
        }
        if (block.type === "list") {
          return (
            <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              {block.items.map((item, itemIndex) => (
                <Box key={`${key}-${itemIndex}`}>
                  <Text color="cyan">{block.ordered ? `${itemIndex + 1}. ` : "- "}</Text>
                  <Text wrap="wrap">{renderInline(item, `${key}-${itemIndex}`)}</Text>
                </Box>
              ))}
            </Box>
          );
        }
        if (block.type === "table") {
          const { widths } = markdownTableLayout(block, columns);
          const alignments = Array.from(
            { length: widths.length },
            (_, columnIndex) => block.alignments[columnIndex] ?? "left",
          );
          return (
            // A table is a fixed-width layout: every line must occupy exactly one
            // row, or a terminal too narrow for the rendered width reflows the
            // rules and headers while the body rows stay truncated, and the
            // borders drift apart. Truncating all of them keeps the grid intact
            // and keeps the height predictable for the stream window.
            <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Text dimColor wrap="truncate-end">
                {tableRule("┌", "┬", "┐", widths)}
              </Text>
              {renderTableRowLines(block.headers, widths, alignments).map((line, lineIndex) => (
                <Text
                  key={`${key}-header-${lineIndex}`}
                  bold
                  color="whiteBright"
                  wrap="truncate-end"
                >
                  {line}
                </Text>
              ))}
              <Text dimColor wrap="truncate-end">
                {tableRule("├", "┼", "┤", widths)}
              </Text>
              {block.rows.flatMap((row, rowIndex) =>
                renderTableRowLines(row, widths, alignments).map((line, lineIndex) => (
                  <Text key={`${key}-${rowIndex}-${lineIndex}`} wrap="truncate-end">
                    {line}
                  </Text>
                )),
              )}
              <Text dimColor wrap="truncate-end">
                {tableRule("└", "┴", "┘", widths)}
              </Text>
            </Box>
          );
        }
        if (block.type === "quote") {
          return (
            <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1} paddingLeft={1}>
              {block.lines.map((line, lineIndex) => (
                <Text key={`${key}-${lineIndex}`} dimColor wrap="wrap">
                  &gt; {renderInline(line, `${key}-${lineIndex}`)}
                </Text>
              ))}
            </Box>
          );
        }
        if (block.type === "code") {
          return (
            <Box
              key={key}
              flexDirection="column"
              marginTop={index === 0 ? 0 : 1}
              paddingX={1}
              borderStyle="single"
              borderColor="gray"
            >
              {block.language ? <Text dimColor>{block.language}</Text> : null}
              {block.lines.length > 0 ? (
                block.lines.map((line, lineIndex) => (
                  <Text key={`${key}-${lineIndex}`} color="whiteBright" wrap="hard">
                    {line.length > 0 ? withTerminalLinks(line) : " "}
                  </Text>
                ))
              ) : (
                <Text> </Text>
              )}
            </Box>
          );
        }
        return (
          <Text key={key} dimColor>
            ----------------------------------------
          </Text>
        );
      })}
      {truncated ? <Text dimColor>... ({blocks.length} blocks total)</Text> : null}
    </Box>
  );
}
