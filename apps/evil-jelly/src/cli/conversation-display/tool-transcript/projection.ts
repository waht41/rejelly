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

function getDiffLineStyle(line: string): Pick<ToolTranscriptRenderLine, "color" | "dim"> {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { color: "green" };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { color: "red" };
  }
  if (line.startsWith("@@")) {
    return { color: "cyan" };
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    return { dim: true };
  }
  return {};
}

function appendFramedDiffLines(
  target: ToolTranscriptRenderLine[],
  diffText: string,
  columns: number,
): void {
  const width = Math.max(8, columns);
  const innerWidth = Math.max(1, width - 4);
  const border = "─".repeat(width - 2);
  target.push({ text: `╭${border}╮`, dim: true });
  for (const rawLine of diffText.split("\n")) {
    const line = rawLine || " ";
    const style = getDiffLineStyle(line);
    for (let offset = 0; offset < line.length; offset += innerWidth) {
      const segment = line.slice(offset, offset + innerWidth).padEnd(innerWidth, " ");
      target.push({ text: `│ ${segment} │`, ...style });
    }
  }
  target.push({ text: `╰${border}╯`, dim: true });
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
    allLines.push({ text: "Diff", color: "cyan" });
    appendFramedDiffLines(allLines, entry.tool.detail.text, columns);
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
