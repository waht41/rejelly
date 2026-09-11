import { describe, expect, it } from "vitest";
import {
  applyRunningToolOutput,
  finishRunningTool,
  RUNNING_TOOL_TRANSCRIPT_CAP_BYTES,
  startRunningTool,
} from "./state";

describe("running tool state", () => {
  it("starts and finishes a tool by handle", () => {
    const tools = startRunningTool(
      [],
      { id: "tool-1", ordinal: 2 },
      { toolName: "read_file", summary: "read files", args: '{"path":"a.ts"}' },
    );
    expect(tools[0]).toEqual({
      id: "tool-1",
      ordinal: 2,
      toolName: "read_file",
      summary: "read files",
      args: '{"path":"a.ts"}',
      outputLines: [],
      partial: "",
      lineCount: 0,
      droppedLineCount: 0,
      retainedBytes: 0,
    });
    expect(finishRunningTool(tools, "tool-1")).toEqual([]);
  });

  it("retains running output beyond the dashboard viewport", () => {
    const tools = startRunningTool(
      [],
      { id: "tool-1", ordinal: 1 },
      { toolName: "run_command", summary: "shell" },
    );
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const next = applyRunningToolOutput(tools, new Map([["tool-1", { lines, rest: "partial" }]]));

    expect(next[0]?.outputLines).toEqual(lines);
    expect(next[0]?.lineCount).toBe(40);
    expect(next[0]?.partial).toBe("partial");
  });

  it("evicts the oldest transcript lines when the byte cap is reached", () => {
    const tools = startRunningTool(
      [],
      { id: "tool-1", ordinal: 1 },
      { toolName: "run_command", summary: "shell" },
    );
    const lines = Array.from({ length: 200 }, (_, index) => `${index}:${"x".repeat(600)}`);

    const next = applyRunningToolOutput(tools, new Map([["tool-1", { lines, rest: "" }]]));
    const tool = next[0]!;

    expect(tool.retainedBytes).toBeLessThanOrEqual(RUNNING_TOOL_TRANSCRIPT_CAP_BYTES);
    expect(tool.droppedLineCount).toBeGreaterThan(0);
    expect(tool.outputLines.at(-1)).toBe(lines.at(-1));
    expect(tool.lineCount).toBe(lines.length);
  });
});
