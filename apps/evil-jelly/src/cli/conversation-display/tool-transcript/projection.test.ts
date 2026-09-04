import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import type { Turn } from "../history/model";
import {
  buildToolTranscriptDetailLines,
  buildToolTranscriptEntries,
  findToolTranscriptEntryIndex,
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

  it("keeps selection on the same tool when a newer entry is prepended", () => {
    const selectedEntryId = "t1";
    const before = buildToolTranscriptEntries([toolTurn("t1"), toolTurn("t2")]);
    const after = buildToolTranscriptEntries([toolTurn("t1"), toolTurn("t2"), toolTurn("t3")]);

    expect(before[findToolTranscriptEntryIndex(before, selectedEntryId)]?.id).toBe("t1");
    expect(after[findToolTranscriptEntryIndex(after, selectedEntryId)]?.id).toBe("t1");
  });

  it("falls back to the newest tool when no selected identity is available", () => {
    const entries = buildToolTranscriptEntries([toolTurn("t1"), toolTurn("t2")]);

    expect(findToolTranscriptEntryIndex(entries, null)).toBe(0);
    expect(findToolTranscriptEntryIndex(entries, "missing")).toBe(0);
    expect(entries[0]?.id).toBe("t2");
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
        detail: {
          type: "diff",
          text: "--- a\n+++ a\n@@\n-old\n+new",
          caption: "Review",
          phase: "proposed",
        },
        preview: "",
        fullResult: "done",
        ok: false,
      },
    };

    const lines = buildToolTranscriptDetailLines(entry, 20);

    expect(lines[0]).toEqual({ text: "#2 edit_file", color: "red" });
    expect(lines).toContainEqual({ text: "Review", dim: true });
    expect(lines).toContainEqual({ text: "Proposed diff (not applied)", color: "cyan" });
    expect(lines.some((line) => line.text.includes("╭"))).toBe(false);
    expect(lines).not.toContainEqual({ text: "Arguments", color: "cyan" });
  });

  it("uses terminal-cell wrapping and cleaned paths in expanded diff details", () => {
    const entry: ToolTranscriptEntry = {
      id: "t1",
      ordinal: 2,
      tool: {
        toolName: "edit_file",
        summary: "edit a file",
        detail: {
          type: "diff",
          text:
            '--- ".evil-jelly\\\\tmp\\\\demo.txt"\n' +
            '+++ ".evil-jelly\\\\tmp\\\\demo.txt"\n' +
            "@@\n+中文 mixed content 中文",
          phase: "applied",
        },
        preview: "",
        fullResult: "done",
        ok: true,
      },
    };

    const lines = buildToolTranscriptDetailLines(entry, 12);
    const diffStart = lines.findIndex((line) => line.text === "Applied changes") + 1;
    const diffEnd = lines.findIndex(
      (line, index) => index >= diffStart && line.text.startsWith("─"),
    );
    const diffLines = lines.slice(diffStart, diffEnd);

    expect(diffLines.some((line) => line.text.startsWith(".evil-"))).toBe(true);
    expect(diffLines.every((line) => !line.text.includes('"') && !line.text.includes("\\\\"))).toBe(
      true,
    );
    expect(diffLines.some((line) => line.continuation && line.marker === "↳ ")).toBe(true);
    expect(diffLines.every((line) => stringWidth(line.text) <= 12)).toBe(true);
  });
});
