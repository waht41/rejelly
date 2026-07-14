import { describe, expect, it } from "vitest";
import {
  markdownInlineText,
  markdownTableLayout,
  markdownTableRowHeight,
  parseMarkdownBlocks,
  splitStreamingMarkdown,
  terminalCellWidth,
} from "./MarkdownViewer";

describe("parseMarkdownBlocks", () => {
  it("groups prose, headings, lists, quotes, and code fences", () => {
    const blocks = parseMarkdownBlocks(
      [
        "# Title",
        "",
        "First paragraph",
        "continues here.",
        "",
        "- one",
        "- two",
        "",
        "> quoted",
        "> text",
        "",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { type: "heading", depth: 1, text: "Title" },
      { type: "paragraph", text: "First paragraph continues here." },
      { type: "list", ordered: false, items: ["one", "two"] },
      { type: "quote", lines: ["quoted", "text"] },
      { type: "code", language: "ts", lines: ["const value = 1;"] },
    ]);
  });

  it("keeps ordered lists separate from unordered lists", () => {
    expect(parseMarkdownBlocks("1. first\n2. second\n- third")).toEqual([
      { type: "list", ordered: true, items: ["first", "second"] },
      { type: "list", ordered: false, items: ["third"] },
    ]);
  });

  it("parses GFM tables with alignment markers", () => {
    expect(
      parseMarkdownBlocks(
        [
          "| Name | Count | Status |",
          "| :--- | ---: | :---: |",
          "| alpha | 12 | ok |",
          "| beta | 3 | pending |",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "table",
        headers: ["Name", "Count", "Status"],
        alignments: ["left", "right", "center"],
        rows: [
          ["alpha", "12", "ok"],
          ["beta", "3", "pending"],
        ],
      },
    ]);
  });

  it("keeps pipe text without a separator row as prose", () => {
    expect(parseMarkdownBlocks("Use foo | bar as plain text.")).toEqual([
      { type: "paragraph", text: "Use foo | bar as plain text." },
    ]);
  });

  it("consumes incomplete streaming block starts as prose", () => {
    expect(parseMarkdownBlocks("## ")).toEqual([{ type: "paragraph", text: "##" }]);
    expect(parseMarkdownBlocks("- ")).toEqual([{ type: "paragraph", text: "-" }]);
    expect(parseMarkdownBlocks("1. ")).toEqual([{ type: "paragraph", text: "1." }]);
  });
});

describe("splitStreamingMarkdown", () => {
  it("renders everything when the trailing block is stable", () => {
    const text = "# Title\n\nA paragraph still **growing**";
    expect(splitStreamingMarkdown(text)).toEqual({ stable: text, tail: "" });
  });

  it("holds back an unclosed code fence", () => {
    const text = "Intro line\n\n```ts\nconst value = 1;";
    expect(splitStreamingMarkdown(text)).toEqual({
      stable: "Intro line\n",
      tail: "```ts\nconst value = 1;",
    });
  });

  it("renders a closed code fence", () => {
    const text = "```ts\nconst value = 1;\n```";
    expect(splitStreamingMarkdown(text)).toEqual({ stable: text, tail: "" });
  });

  it("holds back a forming table that has no separator row yet", () => {
    const text = "Lead in\n\n| Name | Count |\n| alpha";
    expect(splitStreamingMarkdown(text)).toEqual({
      stable: "Lead in\n",
      tail: "| Name | Count |\n| alpha",
    });
  });

  it("renders a table once the separator row arrives", () => {
    const text = "| Name | Count |\n| --- | --- |\n| alpha | 1 |";
    expect(splitStreamingMarkdown(text)).toEqual({ stable: text, tail: "" });
  });

  it("holds back incomplete heading and list markers", () => {
    expect(splitStreamingMarkdown("Lead in\n\n## ")).toEqual({
      stable: "Lead in\n",
      tail: "## ",
    });
    expect(splitStreamingMarkdown("Lead in\n\n- ")).toEqual({
      stable: "Lead in\n",
      tail: "- ",
    });
    expect(splitStreamingMarkdown("Lead in\n\n1. ")).toEqual({
      stable: "Lead in\n",
      tail: "1. ",
    });
  });
});

describe("markdown table measurement", () => {
  it("constrains long table columns to the viewport", () => {
    const [block] = parseMarkdownBlocks(
      [
        "| Command | Script | Purpose |",
        "| --- | --- | --- |",
        "| release:reconcile | src/cli/reconcile.ts | compare changed packages against changesets and registry tarballs |",
      ].join("\n"),
    );

    expect(block?.type).toBe("table");
    if (block?.type !== "table") {
      return;
    }

    const layout = markdownTableLayout(block, 60);

    expect(layout.renderedWidth).toBeLessThanOrEqual(60);
    expect(Math.max(...layout.widths)).toBeLessThan(
      terminalCellWidth("compare changed packages against changesets and registry tarballs"),
    );
    expect(markdownTableRowHeight(block.rows[0] ?? [], layout.widths)).toBeGreaterThan(1);
  });

  it("measures rendered inline text instead of markdown source text", () => {
    expect(markdownInlineText("`ast_find_references` and **孤立**")).toBe(
      "ast_find_references and 孤立",
    );
    expect(terminalCellWidth(markdownInlineText("`abc`"))).toBe(3);
  });

  it("counts CJK and emoji using terminal cell width", () => {
    expect(terminalCellWidth("孤立")).toBe(4);
    expect(terminalCellWidth("✅仍在使用")).toBe(10);
  });
});
