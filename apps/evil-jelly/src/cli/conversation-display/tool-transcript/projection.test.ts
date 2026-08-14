import { describe, expect, it } from "vitest";
import type { Turn } from "../history/model";
import {
  buildToolTranscriptDetailLines,
  buildToolTranscriptEntries,
  type ToolTranscriptEntry,
} from "./projection";

function toolTurn(id: string, ordinal?: number): Extract<Turn, { type: "tool" }> {
  return {
    id,
    type: "tool",
    content: `summary ${id}`,
    tool: {
      toolName: "read_file",
      summary: `summary ${id}`,
      preview: "preview",
      fullResult: "result",
      ok: true,
      ordinal,
    },
  };
}

describe("tool transcript projection", () => {
  it("lists completed tools newest first and supplies fallback ordinals", () => {
    const history: Turn[] = [
      { id: "u1", type: "user", content: "inspect" },
      toolTurn("t1"),
      toolTurn("t2", 7),
    ];

    expect(buildToolTranscriptEntries(history).map(({ id, ordinal }) => ({ id, ordinal }))).toEqual(
      [
        { id: "t2", ordinal: 7 },
        { id: "t1", ordinal: 1 },
      ],
    );
  });

  it("projects arguments and wraps result rows to the viewport width", () => {
    const entry: ToolTranscriptEntry = {
      id: "t1",
      ordinal: 1,
      tool: {
        toolName: "read_file",
        summary: "read a file",
        args: '{"path":"a"}',
        preview: "",
        fullResult: "abcdefghij",
        ok: true,
      },
    };

    const lines = buildToolTranscriptDetailLines(entry, 6);

    expect(lines).toContainEqual({ text: "Arguments", color: "cyan" });
    expect(lines.slice(-2).map((line) => line.text)).toEqual(["abcdef", "ghij"]);
  });

  it("renders review details instead of raw arguments when a diff is present", () => {
    const entry: ToolTranscriptEntry = {
      id: "t1",
      ordinal: 2,
      tool: {
        toolName: "edit_file",
        summary: "edit a file",
        args: "ignored",
        detail: { type: "diff", text: "--- a\n+++ a\n@@\n-old\n+new", caption: "Review" },
        preview: "",
        fullResult: "done",
        ok: false,
      },
    };

    const lines = buildToolTranscriptDetailLines(entry, 20);

    expect(lines[0]).toEqual({ text: "#2 edit_file", color: "red" });
    expect(lines).toContainEqual({ text: "Review", dim: true });
    expect(lines).toContainEqual({ text: "Diff", color: "cyan" });
    expect(lines).not.toContainEqual({ text: "Arguments", color: "cyan" });
  });
});
