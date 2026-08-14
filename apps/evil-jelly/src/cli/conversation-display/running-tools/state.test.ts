import { describe, expect, it } from "vitest";
import { applyRunningToolOutput, finishRunningTool, startRunningTool } from "./state";

describe("running tool state", () => {
  it("starts and finishes a tool by handle", () => {
    const tools = startRunningTool([], { id: "tool-1", ordinal: 2 }, "read files");
    expect(tools[0]).toEqual({
      id: "tool-1",
      ordinal: 2,
      summary: "read files",
      tail: [],
      partial: "",
      lineCount: 0,
    });
    expect(finishRunningTool(tools, "tool-1")).toEqual([]);
  });

  it("keeps only the newest display tail while counting every line", () => {
    const tools = startRunningTool([], { id: "tool-1", ordinal: 1 }, "shell");
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const next = applyRunningToolOutput(tools, new Map([["tool-1", { lines, rest: "partial" }]]));

    expect(next[0]?.tail).toEqual(lines.slice(-32));
    expect(next[0]?.lineCount).toBe(40);
    expect(next[0]?.partial).toBe("partial");
  });
});
