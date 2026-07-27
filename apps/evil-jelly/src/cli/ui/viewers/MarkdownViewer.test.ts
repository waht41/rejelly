import { renderToString } from "ink";
import { createElement } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import {
  MarkdownViewer,
  markdownHeadingStyle,
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

describe("MarkdownViewer headings", () => {
  it("gives each level its own marker so a numbered heading is not read as a list item", () => {
    const output = renderToString(
      createElement(MarkdownViewer, {
        text: ["# Alpha", "## Beta", "### 2. Gamma", "#### Delta", "1. item"].join("\n"),
        columns: 40,
      }),
      { columns: 40 },
    );

    expect(stripAnsi(output).split("\n")).toEqual([
      "Alpha",
      // The rule underlines the title, not the viewport.
      "━━━━━",
      "",
      "▌ Beta",
      "",
      "● 2. Gamma",
      "",
      "· Delta",
      "",
      "1. item",
    ]);
  });

  it("dims and cools the colour ramp as the level deepens", () => {
    expect(markdownHeadingStyle(1)).toMatchObject({ color: "cyanBright", bold: true, rule: true });
    expect(markdownHeadingStyle(2)).toMatchObject({ color: "cyanBright", bold: true, rule: false });
    expect(markdownHeadingStyle(3)).toMatchObject({ color: "cyan", bold: true });
    expect(markdownHeadingStyle(4)).toMatchObject({ color: "blue", bold: false, dim: false });
    // Every level past the table shares the deepest style instead of falling off it.
    expect(markdownHeadingStyle(6)).toEqual(markdownHeadingStyle(5));
    expect(markdownHeadingStyle(6)).toMatchObject({ dim: true });
  });
});

describe("MarkdownViewer code blocks", () => {
  it("hard-wraps long code lines without truncating their content", () => {
    const url = "https://example.com/a/very/long/path?first=alpha&second=omega";
    const output = renderToString(
      createElement(MarkdownViewer, {
        text: ["```text", url, "```"].join("\n"),
        columns: 24,
      }),
      { columns: 24 },
    );

    const visibleOutput = stripAnsi(output);
    const renderedContent = visibleOutput
      .split("\n")
      .slice(2, -1)
      .map((line) => line.slice(2, -2).trimEnd())
      .join("");
    const hyperlinkOpen = `\u001B]8;;${url}\u0007`;

    expect(renderedContent).toBe(url);
    expect(output).not.toContain("…");
    expect(output.split(hyperlinkOpen).length - 1).toBeGreaterThan(1);
  });
});

describe("terminal hyperlinks", () => {
  const render = (text: string, columns: number) =>
    renderToString(createElement(MarkdownViewer, { text, columns }), { columns });

  it("keeps sentence punctuation and wrapping brackets out of the link target", () => {
    const output = render("See (https://example.com/docs), then https://example.com/next.", 80);

    expect(output).toContain("]8;;https://example.com/docs");
    expect(output).toContain("]8;;https://example.com/next");
    expect(output).not.toContain("https://example.com/docs)");
    expect(output).not.toContain("https://example.com/next.");
    expect(stripAnsi(output)).toContain("See (https://example.com/docs), then");
  });

  it("keeps a balanced bracket pair that belongs to the url", () => {
    const output = render("https://example.com/a_(b) tail", 80);

    expect(output).toContain("]8;;https://example.com/a_(b)");
  });

  it("links urls in prose, inline code, and quotes", () => {
    const url = "https://example.com/x";
    const open = `]8;;${url}`;

    expect(render(`prose ${url} here`, 80)).toContain(open);
    expect(render(`prose \`${url}\` here`, 80)).toContain(open);
    expect(render(`> quoted ${url}`, 80)).toContain(open);
  });
});

describe("MarkdownViewer tables", () => {
  it("wraps a long url inside its cell and relinks every wrapped row", () => {
    const url = "https://example.com/very/long/path?token=abcdef123456";
    const output = renderToString(
      createElement(MarkdownViewer, {
        text: ["| Name | Link |", "| --- | --- |", `| alpha | ${url} |`].join("\n"),
        columns: 40,
      }),
      { columns: 40 },
    );

    const open = `]8;;${url}`;
    const visibleLines = stripAnsi(output).split("\n");

    // The cell is narrower than the url, so it must wrap — and stay whole.
    // Drop the grid so the wrapped fragments sit next to each other again.
    expect(output.split(open).length - 1).toBeGreaterThan(1);
    expect(visibleLines.join("").replace(/[│\s]/g, "")).toContain(url);
    expect(output).not.toContain("…");
    // Every line of the grid stays inside the terminal width.
    for (const line of visibleLines) {
      expect(terminalCellWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("truncates an over-wide table instead of reflowing it", () => {
    const output = renderToString(
      createElement(MarkdownViewer, {
        text: ["| Name | Count |", "| --- | --- |", "| alpha | 1 |"].join("\n"),
        columns: 8,
      }),
      { columns: 8 },
    );

    const visibleLines = stripAnsi(output).split("\n");

    // Rules and header used to wrap while body rows truncated, which tore the
    // grid apart; now no line escapes the terminal width.
    for (const line of visibleLines) {
      expect(terminalCellWidth(line)).toBeLessThanOrEqual(8);
    }
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
