import type { ToolObservationDetail } from "../../../shared/tool-observation/model";
import {
  type DiffLineKind,
  projectDiffForDisplay,
} from "../../terminal-ui/rich-text/diffProjection";
import { DIFF_COLORS } from "../../terminal-ui/rich-text/diffTheme";
import type { ToolBlock, Turn } from "../history/model";
import type { RunningTool } from "../running-tools/state";
import { toDisplayLine } from "../running-tools/tailWindow";

export interface ToolTranscriptEntry {
  id: string;
  ordinal: number;
  status: "running" | "completed";
  toolName: string;
  summary: string;
  args?: string;
  detail?: ToolObservationDetail;
  fullResult: string;
  ok?: boolean;
  /** Output lines observed so far; only present while the tool is running. */
  lineCount?: number;
  /** Lines retained in the bounded live transcript, including a visible partial line. */
  retainedLineCount?: number;
  /** Earlier complete lines evicted from the running transcript's byte-bounded window. */
  droppedLineCount?: number;
  /** Absolute source line number represented by the first line in fullResult. */
  outputStartLine: number;
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
  /** Stable semantic row identity used to preserve scroll position while live output changes. */
  anchor?: string;
}

function completedEntry(
  turn: Extract<Turn, { type: "tool" }>,
  ordinal: number,
): ToolTranscriptEntry {
  const tool: ToolBlock = turn.tool;
  return {
    // A live call and its completed block share this handle, keeping an open detail view stable.
    id: tool.id ?? turn.id,
    ordinal: tool.ordinal ?? ordinal,
    status: "completed",
    toolName: tool.toolName,
    summary: tool.summary,
    args: tool.args,
    detail: tool.detail,
    fullResult: tool.fullResult,
    ok: tool.ok,
    outputStartLine: 1,
  };
}

function runningEntry(tool: RunningTool): ToolTranscriptEntry {
  const partial = toDisplayLine(tool.partial);
  const outputLines = partial.length > 0 ? [...tool.outputLines, partial] : tool.outputLines;
  return {
    id: tool.id,
    ordinal: tool.ordinal,
    status: "running",
    toolName: tool.toolName,
    summary: tool.summary,
    args: tool.args,
    fullResult: outputLines.join("\n"),
    lineCount: tool.lineCount + (partial.length > 0 ? 1 : 0),
    retainedLineCount: outputLines.length,
    droppedLineCount: tool.droppedLineCount,
    outputStartLine: tool.droppedLineCount + 1,
  };
}

/** Merge the completed archive with transient calls without changing either lifecycle's ownership. */
export function buildToolTranscriptEntries(
  history: readonly Turn[],
  runningTools: readonly RunningTool[] = [],
): ToolTranscriptEntry[] {
  const completedTurns = history.filter(
    (turn): turn is Extract<Turn, { type: "tool" }> => turn.type === "tool",
  );
  const completed = completedTurns.map((turn, index) => completedEntry(turn, index + 1));
  return [...completed, ...runningTools.map(runningEntry)].sort(
    (left, right) => right.ordinal - left.ordinal,
  );
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
  anchorBase?: string,
): void {
  const width = Math.max(1, columns);
  const rawLines = text.split("\n");
  for (const [rawLineIndex, rawLine] of rawLines.entries()) {
    const line = rawLine || " ";
    if (line.length <= width) {
      target.push({
        text: line,
        ...style,
        anchor: anchorBase === undefined ? undefined : `${anchorBase}:${rawLineIndex}:0`,
      });
      continue;
    }
    let segment = 0;
    for (let offset = 0; offset < line.length; offset += width) {
      target.push({
        text: line.slice(offset, offset + width),
        ...style,
        anchor: anchorBase === undefined ? undefined : `${anchorBase}:${rawLineIndex}:${segment}`,
      });
      segment++;
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

function liveOutputLabel(entry: ToolTranscriptEntry): string {
  const seen = entry.lineCount ?? 0;
  const retained = entry.retainedLineCount ?? 0;
  return retained < seen
    ? `Live output · ${seen} lines seen · retaining latest ${retained}`
    : `Live output · ${seen} lines seen`;
}

/** Project one running or completed tool call into fixed visual rows for the detail viewport. */
export function buildToolTranscriptDetailLines(
  entry: ToolTranscriptEntry,
  columns: number,
): ToolTranscriptRenderLine[] {
  const allLines: ToolTranscriptRenderLine[] = [];
  allLines.push({
    text: `#${entry.ordinal} ${entry.toolName}${entry.status === "running" ? " (running)" : ""}`,
    color: entry.status === "running" ? "yellow" : entry.ok ? "green" : "red",
  });
  allLines.push({ text: entry.summary, dim: true });
  if (entry.detail?.type === "diff" && entry.detail.text.trim().length > 0) {
    allLines.push({ text: " ", dim: true });
    if (entry.detail.caption) {
      allLines.push({ text: entry.detail.caption, dim: true });
    }
    allLines.push({
      text: entry.detail.phase === "proposed" ? "Proposed diff (not applied)" : "Applied changes",
      color: "cyan",
    });
    appendDiffLines(allLines, entry.detail.text, columns);
  } else if (entry.args !== undefined && entry.args.trim().length > 0) {
    allLines.push({ text: " ", dim: true });
    allLines.push({ text: "Arguments", color: "cyan" });
    appendVisualLines(allLines, entry.args, columns, { dim: true });
  }
  if (entry.status === "running") {
    allLines.push({ text: " ", dim: true });
    allLines.push({ text: liveOutputLabel(entry), color: "cyan" });
  }
  allLines.push({ text: "".padEnd(Math.min(columns - 2, 40), "─"), dim: true });
  if (entry.status === "running" && (entry.droppedLineCount ?? 0) > 0) {
    allLines.push({
      text: `… ${entry.droppedLineCount} earlier lines omitted`,
      dim: true,
    });
  }
  if (entry.status === "running" && entry.fullResult.length === 0) {
    allLines.push({ text: "Waiting for output…", dim: true });
  } else {
    for (const [index, line] of entry.fullResult.split("\n").entries()) {
      appendVisualLines(
        allLines,
        line || " ",
        columns,
        {},
        `output:${entry.outputStartLine + index}`,
      );
    }
  }
  return allLines;
}
