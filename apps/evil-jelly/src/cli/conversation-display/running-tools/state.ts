import type { ToolCallHandle } from "../../../shared/tool-observation/model";
import type { ToolOutputDrain } from "./tailWindow";

const TOOL_TAIL_CAP = 32;

/** A tool call between begin and completion, with whatever it has printed so far. */
export interface RunningTool {
  id: string;
  ordinal: number;
  summary: string;
  /** Complete output lines, oldest first. */
  tail: string[];
  /** Raw unterminated remainder of the newest line. */
  partial: string;
  /** Complete lines seen in total, even after old rows leave the tail. */
  lineCount: number;
}

export interface RunningToolsState {
  runningTools: RunningTool[];
}

export function startRunningTool(
  tools: RunningTool[],
  handle: ToolCallHandle,
  summary: string,
): RunningTool[] {
  return [
    ...tools,
    { id: handle.id, ordinal: handle.ordinal, summary, tail: [], partial: "", lineCount: 0 },
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
    const tail = [...tool.tail, ...result.lines];
    return {
      ...tool,
      tail: tail.length > TOOL_TAIL_CAP ? tail.slice(-TOOL_TAIL_CAP) : tail,
      partial: result.rest,
      lineCount: tool.lineCount + result.lines.length,
    };
  });
}

export function finishRunningTool(tools: RunningTool[], id: string | undefined): RunningTool[] {
  return id === undefined ? tools : tools.filter((tool) => tool.id !== id);
}
