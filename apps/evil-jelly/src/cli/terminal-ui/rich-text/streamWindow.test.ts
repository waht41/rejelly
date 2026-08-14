import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";
import { createStreamTailWindow, measureStreamRows, measureWrappedRows } from "./streamWindow";

describe("stream window measurement", () => {
  it("measures wrapped rows with hard wrapping", () => {
    expect(measureWrappedRows("abcdef", 3)).toBe(2);
    expect(measureWrappedRows("孤立abc", 3)).toBe(3);
  });

  it("counts wrapped code lines using the bordered block's content width", () => {
    const text = ["```text", "abcdefghijkl", "```"].join("\n");

    expect(measureStreamRows(text, 10)).toBe(5);
  });

  it("word-wraps prose the way ink does", () => {
    // Hard wrapping packs this into 2 rows; ink's default word wrap needs 3.
    expect(measureWrappedRows("abcde fghij klmno", 10)).toBe(3);
    expect(measureWrappedRows("abcde fghij klmno", 10, { wordWrap: false })).toBe(2);
  });

  it("measures the rows ink actually renders", () => {
    const renderedRows = (text: string, columns: number) =>
      stripAnsi(
        renderToString(createElement(MarkdownViewer, { text, columns }), { columns }),
      ).split("\n").length;
    const columns = 24;
    const text = [
      "# a heading that needs wrapping",
      "",
      "prose with a longword-that-cannot-break inside it",
      "",
      "- list item that wraps around",
      "",
      "> quoted line that also wraps",
      "",
      "| Name | Count |",
      "| --- | --- |",
      "| alpha | 1 |",
      "",
      "```ts",
      "const url = 'https://example.com/very/long/path?token=abcdef';",
      "```",
    ].join("\n");

    expect(measureStreamRows(text, columns)).toBe(renderedRows(text, columns));

    // A table too wide for the terminal is truncated, never reflowed, so its
    // measured height must not grow either.
    const table = ["| Name | Count |", "| --- | --- |", "| alpha | 1 |"].join("\n");
    expect(measureStreamRows(table, 8)).toBe(renderedRows(table, 8));
    // The level glyph shares the title's line while the h1 rule takes one of
    // its own, so both have to be in the budget.
    const headings = ["# a level one heading that wraps", "", "### a level three heading"].join(
      "\n",
    );
    expect(measureStreamRows(headings, columns)).toBe(renderedRows(headings, columns));

    const hardBreak = "line one  \nline two";
    expect(measureStreamRows(hardBreak, columns)).toBe(renderedRows(hardBreak, columns));

    // Nesting indent and a two-digit marker both narrow the text column, so a
    // fixed marker budget would under-count the wrapped rows here.
    const list = [
      "9. an item that wraps at this width",
      "    10. a nested item that wraps too",
    ].join("\n");
    expect(measureStreamRows(list, columns)).toBe(renderedRows(list, columns));
  });

  it("keeps a markdown stream inside the requested row budget", () => {
    const text = [
      "# heading",
      "",
      "first paragraph",
      "",
      "| Name | Count |",
      "| --- | --- |",
      "| alpha | 1 |",
      "| beta | 2 |",
      "",
      "final line",
    ].join("\n");

    const window = createStreamTailWindow({
      text,
      columns: 20,
      maxRows: 4,
    });

    expect(window.clipped).toBe(true);
    expect(window.measuredRows).toBeLessThanOrEqual(4);
    expect(measureStreamRows(window.text, 20)).toBeLessThanOrEqual(4);
    expect(window.text).toContain("final line");
  });

  it("falls back to a raw visual suffix for a single overlong line", () => {
    const window = createStreamTailWindow({
      text: "abcdefghijklmnopqrstuvwxyz",
      columns: 5,
      maxRows: 2,
    });

    expect(window.clipped).toBe(true);
    expect(window.forceRaw).toBe(true);
    expect(measureWrappedRows(window.text, 5)).toBeLessThanOrEqual(2);
    expect(window.text).toBe("uvwxy\nz");
  });
});
