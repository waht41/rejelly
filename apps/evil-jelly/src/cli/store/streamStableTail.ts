import remarkParse from "remark-parse";
import { unified } from "unified";
import { normalizeNewlines } from "../../shared/foundation/string";

const markdownProcessor = unified().use(remarkParse);

type TableHoldbackState =
  | { type: "none" }
  | { type: "pending"; start: number }
  | { type: "confirmed"; start: number };

type FenceKind = "outside" | "markdown" | "other";

type FenceState = {
  marker: "`" | "~";
  length: number;
  kind: FenceKind;
};

type ParsedLine = {
  text: string;
  start: number;
  fenceKind: FenceKind;
};

export type StreamPartition = {
  stableText: string;
  tailText: string;
};

export class StreamStableTailController {
  private source = "";
  private emittedSourceLength = 0;
  private seenStream = false;

  push(delta: string): StreamPartition {
    if (delta.length > 0) {
      this.seenStream = true;
    }
    this.source += normalizeNewlines(delta);
    return this.partition();
  }

  finalize(finalContent: string): { visualRemainder: string; shouldHideFinal: boolean } {
    const normalizedFinal = normalizeNewlines(finalContent);
    const emittedPrefix = this.source.slice(0, this.emittedSourceLength);
    const hadIncrementalOutput = this.seenStream || this.emittedSourceLength > 0;

    let visualRemainder: string;
    if (!hadIncrementalOutput) {
      visualRemainder = normalizedFinal;
    } else if (normalizedFinal.startsWith(emittedPrefix)) {
      visualRemainder = normalizedFinal.slice(emittedPrefix.length);
    } else {
      visualRemainder = this.source.slice(this.emittedSourceLength);
    }

    this.reset();
    return {
      visualRemainder,
      shouldHideFinal: hadIncrementalOutput,
    };
  }

  /**
   * Release whatever the holdback still owns and reset.
   *
   * Unlike {@link finalize} there is no final message to reconcile against: the caller is
   * interrupting a stream that has not produced its reply yet (a system notice landing between
   * tool calls), not replacing it. Passing `""` to finalize would look equivalent but silently
   * drops the remainder whenever nothing was emitted yet — an entirely list-shaped preamble is
   * held back from the first character, so `emittedPrefix` is empty and `"".startsWith("")`
   * takes the "final content already covers it" branch.
   */
  drain(): string {
    const remainder = this.source.slice(this.emittedSourceLength);
    this.reset();
    return remainder;
  }

  reset(): void {
    this.source = "";
    this.emittedSourceLength = 0;
    this.seenStream = false;
  }

  private partition(): StreamPartition {
    const stableEnd = this.targetStableSourceEnd();
    const stableText =
      stableEnd > this.emittedSourceLength
        ? this.source.slice(this.emittedSourceLength, stableEnd)
        : "";
    this.emittedSourceLength = Math.max(this.emittedSourceLength, stableEnd);

    return {
      stableText,
      tailText: this.source.slice(this.emittedSourceLength),
    };
  }

  private targetStableSourceEnd(): number {
    const completeEnd = lastCompleteLineEnd(this.source);
    if (completeEnd === 0) {
      return 0;
    }

    const completeSource = this.source.slice(0, completeEnd);
    const holdbackStarts: number[] = [];

    const openFenceStart = unclosedFenceStart(completeSource);
    if (openFenceStart !== null) {
      holdbackStarts.push(openFenceStart);
    }

    const tableHoldback = tableHoldbackState(completeSource);
    if (tableHoldback.type !== "none") {
      holdbackStarts.push(tableHoldback.start);
    }

    const listStart = activeListStart(completeSource);
    if (listStart !== null) {
      holdbackStarts.push(listStart);
    }

    const indentedCodeStart = activeIndentedCodeStart(completeSource);
    if (indentedCodeStart !== null) {
      holdbackStarts.push(indentedCodeStart);
    }

    if (holdbackStarts.length === 0) {
      return completeEnd;
    }
    return Math.max(0, Math.min(...holdbackStarts, completeEnd));
  }
}

/**
 * Keep a trailing indented code block in one stream fragment.
 *
 * mdast determines whether indentation starts a code block or merely continues
 * another block (for example, a paragraph). Its source position lets us retain
 * the whole block until later content terminates it or the stream finalizes.
 */
function activeIndentedCodeStart(source: string): number | null {
  const tree = markdownProcessor.parse(source);
  const trailingNode = tree.children.at(-1);
  if (trailingNode?.type !== "code") {
    return null;
  }

  const start = trailingNode.position?.start.offset;
  if (typeof start !== "number") {
    return null;
  }

  const firstLine = source.slice(start).split("\n", 1)[0] ?? "";
  return /^(?: {4}|\t)/.test(firstLine) ? start : null;
}

/**
 * Keep a trailing markdown list in one stream fragment.
 *
 * Completed stream lines are normally flushed to Ink's `<Static>` history as
 * soon as they arrive. Splitting a list that way makes every fragment a new
 * markdown document, so an indented child becomes the first (depth-zero) item
 * of its fragment and loses its nesting. Hold the active list until a
 * non-list block terminates it or finalization emits the remaining fragment.
 */
function activeListStart(source: string): number | null {
  let start: number | null = null;

  for (const line of parseLinesWithFenceState(source)) {
    if (line.fenceKind !== "outside") {
      start = null;
      continue;
    }

    const item = line.text.match(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\S/);
    if (item) {
      const indent = item[1]?.length ?? 0;
      if (start !== null || indent <= 3) {
        start ??= line.start;
      }
      continue;
    }

    if (start === null) {
      continue;
    }
    if (line.text.trim().length === 0 || /^\s{2,}\S/.test(line.text)) {
      continue;
    }

    start = null;
  }

  return start;
}

function lastCompleteLineEnd(text: string): number {
  const index = text.lastIndexOf("\n");
  return index === -1 ? 0 : index + 1;
}

function tableHoldbackState(source: string): TableHoldbackState {
  const lines = parseLinesWithFenceState(source);

  for (let index = 0; index < lines.length - 1; index++) {
    const header = lines[index]!;
    const delimiter = lines[index + 1]!;
    if (header.fenceKind !== "outside" || delimiter.fenceKind !== "outside") {
      continue;
    }
    const headerText = tableCandidateText(header.text);
    const delimiterText = tableCandidateText(delimiter.text);
    if (
      headerText !== null &&
      delimiterText !== null &&
      isTableHeaderLine(headerText) &&
      isTableDelimiterLine(delimiterText)
    ) {
      let tableEnd = index + 2;
      while (tableEnd < lines.length && isTableBodyLine(lines[tableEnd]!)) {
        tableEnd++;
      }
      if (tableEnd === lines.length) {
        return { type: "confirmed", start: header.start };
      }
      index = Math.max(index, tableEnd - 1);
    }
  }

  const trailingLine = lines[lines.length - 1];
  if (trailingLine !== undefined && trailingLine.text.trim().length > 0) {
    const candidate =
      trailingLine.fenceKind === "outside" ? tableCandidateText(trailingLine.text) : null;
    if (candidate !== null && isTableHeaderLine(candidate)) {
      return { type: "pending", start: trailingLine.start };
    }
  }

  return { type: "none" };
}

function isTableBodyLine(line: ParsedLine): boolean {
  if (line.fenceKind !== "outside" || line.text.trim().length === 0) {
    return false;
  }
  return tableCandidateText(line.text) !== null;
}

function unclosedFenceStart(source: string): number | null {
  let open: ({ start: number } & FenceState) | null = null;

  for (const line of parseLinesWithFenceState(source)) {
    const leadingSpaces = line.text.match(/^ */)?.[0].length ?? 0;
    if (leadingSpaces > 3) {
      continue;
    }

    const scanText = stripBlockquotePrefix(line.text.slice(leadingSpaces));
    const marker = parseFenceMarker(scanText);
    if (marker === null) {
      continue;
    }

    if (open !== null) {
      if (
        marker.marker === open.marker &&
        marker.length >= open.length &&
        scanText.slice(marker.length).trim().length === 0
      ) {
        open = null;
      }
      continue;
    }

    open = {
      start: line.start,
      marker: marker.marker,
      length: marker.length,
      kind: isMarkdownFenceInfo(scanText, marker.length) ? "markdown" : "other",
    };
  }

  return open?.start ?? null;
}

function parseLinesWithFenceState(source: string): ParsedLine[] {
  const tracker = new FenceTracker();
  const lines: ParsedLine[] = [];
  let start = 0;

  for (const lineWithNewline of splitInclusiveNewline(source)) {
    const text = lineWithNewline.endsWith("\n") ? lineWithNewline.slice(0, -1) : lineWithNewline;
    lines.push({ text, start, fenceKind: tracker.kind() });
    tracker.advance(text);
    start += lineWithNewline.length;
  }

  return lines;
}

function splitInclusiveNewline(source: string): string[] {
  if (source.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") {
      lines.push(source.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < source.length) {
    lines.push(source.slice(start));
  }
  return lines;
}

function tableCandidateText(line: string): string | null {
  const stripped = stripBlockquotePrefix(line).trim();
  return parseTableSegments(stripped) === null ? null : stripped;
}

function parseTableSegments(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const hasOuterPipe = trimmed.startsWith("|") || trimmed.endsWith("|");
  const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const segments = splitUnescapedPipe(content);
  if (!hasOuterPipe && segments.length <= 1) {
    return null;
  }

  return segments.map((segment) => segment.trim());
}

function splitUnescapedPipe(content: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "|") {
      segments.push(content.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(content.slice(start));
  return segments;
}

function isTableHeaderLine(line: string): boolean {
  return parseTableSegments(line)?.some((segment) => segment.length > 0) ?? false;
}

function isTableDelimiterLine(line: string): boolean {
  return parseTableSegments(line)?.every(isTableDelimiterSegment) ?? false;
}

function isTableDelimiterSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const withoutLeading = trimmed.startsWith(":") ? trimmed.slice(1) : trimmed;
  const withoutEnds = withoutLeading.endsWith(":") ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutEnds.length >= 3 && /^-+$/.test(withoutEnds);
}

class FenceTracker {
  private state: FenceState | null = null;

  kind(): FenceKind {
    return this.state?.kind ?? "outside";
  }

  advance(rawLine: string): void {
    const leadingSpaces = rawLine.match(/^ */)?.[0].length ?? 0;
    if (leadingSpaces > 3) {
      return;
    }

    const line = stripBlockquotePrefix(rawLine.slice(leadingSpaces));
    const marker = parseFenceMarker(line);
    if (marker === null) {
      return;
    }

    if (this.state !== null) {
      if (
        marker.marker === this.state.marker &&
        marker.length >= this.state.length &&
        line.slice(marker.length).trim().length === 0
      ) {
        this.state = null;
      }
      return;
    }

    this.state = {
      marker: marker.marker,
      length: marker.length,
      kind: isMarkdownFenceInfo(line, marker.length) ? "markdown" : "other",
    };
  }
}

function parseFenceMarker(line: string): { marker: "`" | "~"; length: number } | null {
  const first = line[0];
  if (first !== "`" && first !== "~") {
    return null;
  }
  let length = 0;
  while (line[length] === first) {
    length++;
  }
  return length >= 3 ? { marker: first, length } : null;
}

function isMarkdownFenceInfo(line: string, markerLength: number): boolean {
  const info = line.slice(markerLength).trimStart().split(/\s+/, 1)[0] ?? "";
  return info.toLowerCase() === "md" || info.toLowerCase() === "markdown";
}

function stripBlockquotePrefix(line: string): string {
  let rest = line.trimStart();
  while (rest.startsWith(">")) {
    rest = rest.slice(1);
    if (rest.startsWith(" ")) {
      rest = rest.slice(1);
    }
    rest = rest.trimStart();
  }
  return rest;
}
