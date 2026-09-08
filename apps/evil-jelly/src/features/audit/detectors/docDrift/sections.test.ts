import { describe, expect, it } from "vitest";
import { splitMarkdownSections } from "./sections";

describe("splitMarkdownSections", () => {
  it("defaults to H1/H2 splitting and keeps H3+ inside the section", () => {
    const md = [
      "# Title",
      "intro",
      "## First",
      "body",
      "### Sub",
      "more",
      "## Second",
      "tail",
    ].join("\n");
    const sections = splitMarkdownSections(md);
    expect(sections.map((s) => s.heading)).toEqual(["Title", "First", "Second"]);
    const first = sections[1];
    expect(first.headingPath).toEqual(["Title", "First"]);
    expect(first.startLine).toBe(3);
    expect(first.endLine).toBe(6);
    expect(first.text).toContain("### Sub");
  });

  it("opts into H3 splitting and preserves the full available heading path", () => {
    const md = [
      "# Title",
      "intro",
      "## Configuration",
      "body",
      "### MCP settings and commands",
      "details",
      "### Environment",
      "more",
    ].join("\n");
    const sections = splitMarkdownSections(md, 3);
    expect(sections.map((s) => s.heading)).toEqual([
      "Title",
      "Configuration",
      "MCP settings and commands",
      "Environment",
    ]);
    expect(sections[2].headingPath).toEqual([
      "Title",
      "Configuration",
      "MCP settings and commands",
    ]);
    expect(sections[2].startLine).toBe(5);
    expect(sections[2].endLine).toBe(6);
  });

  it("uses available ancestors when heading levels are skipped", () => {
    const sections = splitMarkdownSections("# Root\nintro\n### Deep\nbody", 3);
    expect(sections[1].headingPath).toEqual(["Root", "Deep"]);
  });

  it("does not split on headings inside fenced code blocks", () => {
    const md = [
      "## Real",
      "```md",
      "# Markdown",
      "## Fake",
      "### Also fake",
      "```",
      "after fence",
      "### Next",
    ].join("\n");
    const sections = splitMarkdownSections(md, 3);
    expect(sections.map((s) => s.heading)).toEqual(["Real", "Next"]);
    expect(sections[0].text).toContain("### Also fake");
    expect(sections[0].endLine).toBe(7);
  });

  it("handles tilde fences and longer closing fences", () => {
    const md = ["## A", "~~~", "## inside", "~~~~", "## B"].join("\n");
    const sections = splitMarkdownSections(md);
    expect(sections.map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("does not close a fence with the other marker", () => {
    const md = ["## A", "```", "~~~", "# still inside", "```", "## B"].join("\n");
    const sections = splitMarkdownSections(md);
    expect(sections.map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("captures content before the first heading as a preamble", () => {
    const md = ["some intro", "", "## First", "body"].join("\n");
    const sections = splitMarkdownSections(md);
    expect(sections[0].heading).toBe("(preamble)");
    expect(sections[0].startLine).toBe(1);
    expect(sections[0].endLine).toBe(2);
  });

  it("drops blank-only sections", () => {
    const md = ["", "", "## Only", "body"].join("\n");
    const sections = splitMarkdownSections(md);
    expect(sections.map((s) => s.heading)).toEqual(["Only"]);
  });

  it("uses a bare H2 path when there is no H1", () => {
    const md = ["## Standalone", "text"].join("\n");
    const sections = splitMarkdownSections(md);
    expect(sections[0].headingPath).toEqual(["Standalone"]);
  });
});
