import { link as terminalLink } from "ansi-escapes";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { normalizeNewlines } from "../../../shared/foundation/string";
import {
  type MarkdownBlock,
  type MarkdownListItem,
  type MarkdownPhrasingContent,
  parseMarkdownBlocks,
  phrasingText,
  type TableAlignment,
} from "./markdownParser";

const MAX_RENDER_BLOCKS = 500;
const MIN_TABLE_COLUMN_WIDTH = 3;
const HEADING_RULE_CHARACTER = "━";
const LIST_INDENT_COLUMNS = 2;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const URL_TRAILING_PUNCTUATION = ".,;:!?";
const URL_CLOSING_PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

export type MarkdownHeadingStyle = {
  prefix: string;
  color: string;
  bold: boolean;
  dim: boolean;
  rule: boolean;
};

// Levels past the ramp all land here rather than falling back to no style.
const DEEPEST_HEADING_STYLE: MarkdownHeadingStyle = {
  prefix: "· ",
  color: "blue",
  bold: false,
  dim: true,
  rule: false,
};

// Stripping the `#` markers also strips the only signal that a line is a
// heading, which leaves an `### 2. Foo` section title looking exactly like a
// top-level ordered item. Each level therefore gets a *different kind* of
// signal — a rule, a bar, a disc, a dot — rather than a weaker shade of the
// same one, so the hierarchy survives a low-contrast terminal or a reader who
// cannot separate the cyan ramp.
const HEADING_STYLES: MarkdownHeadingStyle[] = [
  { prefix: "", color: "cyanBright", bold: true, dim: false, rule: true },
  { prefix: "▌ ", color: "cyanBright", bold: true, dim: false, rule: false },
  { prefix: "● ", color: "cyan", bold: true, dim: false, rule: false },
  { prefix: "· ", color: "blue", bold: false, dim: false, rule: false },
  DEEPEST_HEADING_STYLE,
];

export function markdownHeadingStyle(depth: number): MarkdownHeadingStyle {
  return HEADING_STYLES[depth - 1] ?? DEEPEST_HEADING_STYLE;
}

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

function isTableStart(lines: string[], index: number): boolean {
  return parseMarkdownBlocks(lines.slice(index).join("\n"))[0]?.type === "table";
}

export function markdownListItemPrefix(item: MarkdownListItem): string {
  return item.marker === null ? "- " : `${item.marker}. `;
}

export function markdownListItemIndent(item: MarkdownListItem): number {
  return item.depth * LIST_INDENT_COLUMNS;
}

function isIncompleteStreamingBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+$/.test(line) || /^\s{0,3}[-*+]\s+$/.test(line) || /^\s{0,3}\d+[.)]\s+$/.test(line)
  );
}

function renderInlineNodes(nodes: MarkdownPhrasingContent[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${node.type}-${index}`;
    if (node.type === "text") {
      return withTerminalLinks(node.value.replace(/\n/g, " "));
    }
    if (node.type === "inlineCode") {
      return (
        <Text key={key} color="cyan">
          {withTerminalLinks(node.value)}
        </Text>
      );
    }
    if (node.type === "strong") {
      return (
        <Text key={key} bold>
          {renderInlineNodes(node.children, key)}
        </Text>
      );
    }
    if (node.type === "emphasis") {
      return (
        <Text key={key} italic>
          {renderInlineNodes(node.children, key)}
        </Text>
      );
    }
    if (node.type === "delete") {
      return (
        <Text key={key} strikethrough>
          {renderInlineNodes(node.children, key)}
        </Text>
      );
    }
    if (node.type === "link") {
      const label = phrasingText(node.children);
      try {
        return terminalLink(label, new URL(node.url).href);
      } catch {
        return label;
      }
    }
    if (node.type === "break") {
      return "\n";
    }
    if (node.type === "image") {
      return node.alt ?? "";
    }
    if (node.type === "footnoteReference") {
      return `[^${node.label ?? node.identifier}]`;
    }
    if ("children" in node) {
      return <Text key={key}>{renderInlineNodes(node.children, key)}</Text>;
    }
    return phrasingText([node]);
  });
}

function QuoteLine({ depth, children }: { depth: number; children: ReactNode }) {
  let content: ReactNode = <Text wrap="wrap">{children}</Text>;

  for (let level = 0; level < depth; level++) {
    content = (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="cyan"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        paddingLeft={1}
      >
        {content}
      </Box>
    );
  }

  return content;
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
      terminalCellWidth(tableCellText(block.headers, columnIndex)),
      ...block.rows.map((row) => terminalCellWidth(tableCellText(row, columnIndex))),
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
  const text = withTerminalLinks(value);
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
export function StreamMarkdownViewer({ text, columns }: { text: string; columns: number }) {
  const { stable, tail } = splitStreamingMarkdown(text);
  return (
    <Box flexDirection="column">
      {stable.trim().length > 0 ? <MarkdownViewer text={stable} columns={columns} /> : null}
      {tail.length > 0 ? <Text>{tail}</Text> : null}
    </Box>
  );
}

export function MarkdownViewer({ text, columns }: { text: string; columns: number }) {
  const blocks = parseMarkdownBlocks(text);
  const truncated = blocks.length > MAX_RENDER_BLOCKS;
  const visibleBlocks = truncated ? blocks.slice(0, MAX_RENDER_BLOCKS) : blocks;

  return (
    <Box flexDirection="column">
      {visibleBlocks.map((block, index) => {
        const key = `${index}:${block.type}`;
        if (block.type === "heading") {
          const style = markdownHeadingStyle(block.depth);
          // The rule underlines the title rather than the viewport, so it stays
          // a heading ornament instead of reading as a horizontal divider.
          const ruleWidth = Math.min(Math.max(1, columns), terminalCellWidth(block.text));
          return (
            <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Text bold={style.bold} dimColor={style.dim} color={style.color} wrap="wrap">
                {style.prefix}
                {renderInlineNodes(block.nodes, key)}
              </Text>
              {style.rule ? <Text dimColor>{HEADING_RULE_CHARACTER.repeat(ruleWidth)}</Text> : null}
            </Box>
          );
        }
        if (block.type === "paragraph") {
          return (
            <Box key={key} marginTop={index === 0 ? 0 : 1}>
              <Text wrap="wrap">{renderInlineNodes(block.nodes, key)}</Text>
            </Box>
          );
        }
        if (block.type === "list") {
          return (
            <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              {block.items.map((item, itemIndex) => (
                <Box key={`${key}-${itemIndex}`} paddingLeft={markdownListItemIndent(item)}>
                  {/* flexShrink={0}: once the row is width-constrained, Yoga resolves an
                      over-wide line by squeezing this marker instead of wrapping the text,
                      which silently eats the space after "1." and misaligns the item. */}
                  <Box flexShrink={0}>
                    <Text color="cyan">{markdownListItemPrefix(item)}</Text>
                  </Box>
                  <Text wrap="wrap">{renderInlineNodes(item.nodes, `${key}-${itemIndex}`)}</Text>
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
                <QuoteLine key={`${key}-${lineIndex}`} depth={line.depth}>
                  {line.nodes.length > 0
                    ? renderInlineNodes(line.nodes, `${key}-${lineIndex}`)
                    : " "}
                </QuoteLine>
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
