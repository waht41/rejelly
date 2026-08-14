import { describe, expect, it } from "vitest";
import { splitMarkdownH2Sections } from "./sections";

describe("splitMarkdownH2Sections", () => {
  it("splits on H1/H2 and keeps H3+ inside the section", () => {
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
    const sections = splitMarkdownH2Sections(md);
    expect(sections.map((s) => s.heading)).toEqual(["Title", "First", "Second"]);
    const first = sections[1];
    expect(first.headingPath).toEqual(["Title", "First"]);
    expect(first.startLine).toBe(3);
    expect(first.endLine).toBe(6);
    expect(first.text).toContain("### Sub");
  });

  it("does not split on headings inside fenced code blocks", () => {
    const md = ["## Real", "```md", "# Markdown", "## Fake", "```", "after fence", "## Next"].join(
      "\n",
    );
    const sections = splitMarkdownH2Sections(md);
    expect(sections.map((s) => s.heading)).toEqual(["Real", "Next"]);
    expect(sections[0].text).toContain("## Fake");
    expect(sections[0].endLine).toBe(6);
  });

  it("handles tilde fences and longer closing fences", () => {
    const md = ["## A", "~~~", "## inside", "~~~~", "## B"].join("\n");
    const sections = splitMarkdownH2Sections(md);
    expect(sections.map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("does not close a fence with the other marker", () => {
    const md = ["## A", "```", "~~~", "# still inside", "```", "## B"].join("\n");
    const sections = splitMarkdownH2Sections(md);
    expect(sections.map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("captures content before the first heading as a preamble", () => {
    const md = ["some intro", "", "## First", "body"].join("\n");
    const sections = splitMarkdownH2Sections(md);
    expect(sections[0].heading).toBe("(preamble)");
    expect(sections[0].startLine).toBe(1);
    expect(sections[0].endLine).toBe(2);
  });

  it("drops blank-only sections", () => {
    const md = ["", "", "## Only", "body"].join("\n");
    const sections = splitMarkdownH2Sections(md);
    expect(sections.map((s) => s.heading)).toEqual(["Only"]);
  });

  it("uses a bare H2 path when there is no H1", () => {
    const md = ["## Standalone", "text"].join("\n");
    const sections = splitMarkdownH2Sections(md);
    expect(sections[0].headingPath).toEqual(["Standalone"]);
  });
});
