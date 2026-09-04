import {
  type DiffLineKind,
  projectDiffForDisplay,
} from "../../terminal-ui/rich-text/diffProjection";
import { DIFF_COLORS } from "../../terminal-ui/rich-text/diffTheme";
import type { ToolBlock, Turn } from "../history/model";

export interface ToolTranscriptEntry {
  id: string;
  tool: ToolBlock;
  ordinal: number;
}

/** One viewport line plus how to color it. Each entry is exactly one visual row. */
export interface ToolTranscriptRenderLine {
  text: string;
  color?: string;
  dim?: boolean;
  gutter?: string;
  marker?: string;
  content?: string;
  continuation?: boolean;
}

export function buildToolTranscriptEntries(history: readonly Turn[]): ToolTranscriptEntry[] {
  return history
    .filter((turn) => turn.type === "tool")
    .map((turn, index) => ({
      id: turn.id,
      tool: turn.tool,
      ordinal: turn.tool.ordinal ?? index + 1,
    }))
    .reverse();
}

/** Keep selection attached to a tool identity when newer entries are prepended. */
export function findToolTranscriptEntryIndex(
  entries: readonly ToolTranscriptEntry[],
  selectedEntryId: string | null,
): number {
  if (selectedEntryId === null) {
    return 0;
  }
  return Math.max(
    0,
    entries.findIndex((entry) => entry.id === selectedEntryId),
  );
}

function appendVisualLines(
  target: ToolTranscriptRenderLine[],
  text: string,
  columns: number,
  style: Pick<ToolTranscriptRenderLine, "color" | "dim"> = {},
): void {
  const width = Math.max(1, columns);
  const rawLines = text.split("\n");
  for (const rawLine of rawLines) {
    const line = rawLine || " ";
    if (line.length <= width) {
      target.push({ text: line, ...style });
      continue;
    }
    for (let offset = 0; offset < line.length; offset += width) {
      target.push({ text: line.slice(offset, offset + width), ...style });
    }
  }
}

function getDiffLineStyle(kind: DiffLineKind): Pick<ToolTranscriptRenderLine, "color" | "dim"> {
  if (kind === "addition") {
    return { color: DIFF_COLORS.addition };
  }
  if (kind === "deletion") {
    return { color: DIFF_COLORS.deletion };
  }
  if (kind === "hunk") {
    return { color: DIFF_COLORS.hunk };
  }
  if (kind === "meta" || kind === "fold") {
    return { color: DIFF_COLORS.meta, dim: true };
  }
  return {};
}

function appendDiffLines(
  target: ToolTranscriptRenderLine[],
  diffText: string,
  columns: number,
): void {
  for (const line of projectDiffForDisplay(diffText, columns)) {
    const style = getDiffLineStyle(line.kind);
    target.push({
      text: line.text,
      gutter: line.gutter,
      marker: line.marker,
      content: line.content,
      continuation: line.continuation,
      ...style,
    });
  }
}

/** Project one completed tool call into fixed visual rows for the detail viewport. */
export function buildToolTranscriptDetailLines(
  entry: ToolTranscriptEntry,
  columns: number,
): ToolTranscriptRenderLine[] {
  const allLines: ToolTranscriptRenderLine[] = [];
  allLines.push({
    text: `#${entry.ordinal} ${entry.tool.toolName}`,
    color: entry.tool.ok ? "green" : "red",
  });
  allLines.push({ text: entry.tool.summary, dim: true });
  if (entry.tool.detail?.type === "diff" && entry.tool.detail.text.trim().length > 0) {
    allLines.push({ text: " ", dim: true });
    if (entry.tool.detail.caption) {
      allLines.push({ text: entry.tool.detail.caption, dim: true });
    }
    allLines.push({
      text:
        entry.tool.detail.phase === "proposed" ? "Proposed diff (not applied)" : "Applied changes",
      color: "cyan",
    });
    appendDiffLines(allLines, entry.tool.detail.text, columns);
  } else if (entry.tool.args !== undefined && entry.tool.args.trim().length > 0) {
    allLines.push({ text: " ", dim: true });
    allLines.push({ text: "Arguments", color: "cyan" });
    appendVisualLines(allLines, entry.tool.args, columns, { dim: true });
  }
  allLines.push({ text: "".padEnd(Math.min(columns - 2, 40), "─"), dim: true });
  for (const line of entry.tool.fullResult.split("\n")) {
    appendVisualLines(allLines, line || " ", columns);
  }
  return allLines;
}
