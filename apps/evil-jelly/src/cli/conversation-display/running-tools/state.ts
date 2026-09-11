import type { ToolCallHandle, ToolObservationStart } from "../../../shared/tool-observation/model";
import type { ToolOutputDrain } from "./tailWindow";

export const RUNNING_TOOL_TRANSCRIPT_CAP_BYTES = 96_000;

function outputLineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8") + 1;
}

/** A tool call between begin and completion, with whatever it has printed so far. */
export interface RunningTool {
  id: string;
  ordinal: number;
  toolName: string;
  summary: string;
  args?: string;
  /** Retained complete output lines, oldest first; the dashboard derives its tail from these. */
  outputLines: string[];
  /** Raw unterminated remainder of the newest line. */
  partial: string;
  /** Complete lines seen in total, including lines evicted from the retained transcript. */
  lineCount: number;
  /** Complete lines removed from the front after the transcript byte cap was reached. */
  droppedLineCount: number;
  /** UTF-8 bytes retained by outputLines, including one newline byte per line. */
  retainedBytes: number;
}

export interface RunningToolsState {
  runningTools: RunningTool[];
}

export function startRunningTool(
  tools: RunningTool[],
  handle: ToolCallHandle,
  start: ToolObservationStart,
): RunningTool[] {
  return [
    ...tools,
    {
      id: handle.id,
      ordinal: handle.ordinal,
      toolName: start.toolName,
      summary: start.summary,
      args: start.args,
      outputLines: [],
      partial: "",
      lineCount: 0,
      droppedLineCount: 0,
      retainedBytes: 0,
    },
  ];
}

export function applyRunningToolOutput(
  tools: RunningTool[],
  drained: ReadonlyMap<string, ToolOutputDrain>,
): RunningTool[] {
  return tools.map((tool) => {
    const result = drained.get(tool.id);
    if (!result) {
      return tool;
    }
    const outputLines = [...tool.outputLines, ...result.lines];
    let retainedBytes =
      tool.retainedBytes + result.lines.reduce((total, line) => total + outputLineBytes(line), 0);
    let dropCount = 0;
    while (dropCount < outputLines.length && retainedBytes > RUNNING_TOOL_TRANSCRIPT_CAP_BYTES) {
      retainedBytes -= outputLineBytes(outputLines[dropCount]!);
      dropCount++;
    }
    return {
      ...tool,
      outputLines: dropCount > 0 ? outputLines.slice(dropCount) : outputLines,
      partial: result.rest,
      lineCount: tool.lineCount + result.lines.length,
      droppedLineCount: tool.droppedLineCount + dropCount,
      retainedBytes,
    };
  });
}

export function finishRunningTool(tools: RunningTool[], id: string | undefined): RunningTool[] {
  return id === undefined ? tools : tools.filter((tool) => tool.id !== id);
}
