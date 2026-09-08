import { describe, expect, it } from "vitest";
import { applyBlockEdits, findBlockToReplace, replacementForBlockMatch } from "./blockReplace";

describe("workspace block replacement", () => {
  it("returns normalizedContent so CRLF inputs do not drift indices", () => {
    const raw = "line1\r\n  foo\r\nline3";
    const match = findBlockToReplace(raw, "  foo");
    expect(match.ok).toBe(true);
    if (!match.ok) {
      return;
    }
    expect(match.normalizedContent).toBe("line1\n  foo\nline3");
    expect(match.mode).toBe("exact");
    const hay = match.normalizedContent;
    const merged = replacementForBlockMatch(match, hay, "  bar");
    const next = hay.slice(0, match.start) + merged + hay.slice(match.end);
    expect(next).toBe("line1\n  bar\nline3");
  });

  it("exact match on indented line keeps indentation without line_trim", () => {
    const file = "function f() {\n    return x;\n}\n";
    const match = findBlockToReplace(file, "return x;");
    expect(match.ok).toBe(true);
    if (!match.ok) {
      return;
    }
    expect(match.mode).toBe("exact");
    const hay = match.normalizedContent;
    const merged = replacementForBlockMatch(match, hay, "return 0;");
    const next = hay.slice(0, match.start) + merged + hay.slice(match.end);
    expect(next).toContain("    return 0;");
    expect(next).not.toContain("\nreturn 0;");
  });

  it("line_trim on CRLF file yields correct slice offsets", () => {
    const file = "function f() {\r\n    foo();\r\n    bar();\r\n}\r\n";
    const match = findBlockToReplace(file, "foo();\nbar();");
    expect(match.ok).toBe(true);
    if (!match.ok) {
      return;
    }
    expect(match.mode).toBe("line_trim");
    const hay = match.normalizedContent;
    const merged = replacementForBlockMatch(match, hay, "baz();\nqux();");
    const next = hay.slice(0, match.start) + merged + hay.slice(match.end);
    expect(next).toContain("    baz();");
    expect(next).toContain("    qux();");
  });

  it("line_trim preserves first-line indent when agent omits spaces (multi-line exact fails)", () => {
    const file = "function f() {\n    foo();\n    bar();\n}\n";
    const match = findBlockToReplace(file, "foo();\nbar();");
    expect(match.ok).toBe(true);
    if (!match.ok) {
      return;
    }
    expect(match.mode).toBe("line_trim");
    const hay = match.normalizedContent;
    const merged = replacementForBlockMatch(match, hay, "baz();\nqux();");
    const next = hay.slice(0, match.start) + merged + hay.slice(match.end);
    expect(next).toContain("    baz();");
    expect(next).toContain("    qux();");
    expect(next).not.toContain("\nbaz();");
  });

  it("line_trim ignores a trailing blank line in searchBlock when indentation differs", () => {
    const file = "function f() {\n    foo();\n    bar();\n}\n";
    // Agent copied the block without indent and left a trailing newline -> trailing blank needle line.
    const match = findBlockToReplace(file, "foo();\nbar();\n");
    expect(match.ok).toBe(true);
    if (!match.ok) {
      return;
    }
    expect(match.mode).toBe("line_trim");
    const hay = match.normalizedContent;
    // The matched region must stop at bar(); and not swallow the closing brace.
    expect(hay.slice(match.start, match.end)).toBe("    foo();\n    bar();");
  });

  it("line_trim does not double-indent when replaceBlock repeats outer indent", () => {
    const file = "function f() {\n    foo();\n    bar();\n}\n";
    const match = findBlockToReplace(file, "foo();\nbar();");
    expect(match.ok).toBe(true);
    if (!match.ok) {
      return;
    }
    const hay = match.normalizedContent;
    const merged = replacementForBlockMatch(match, hay, "    baz();\n    qux();");
    const next = hay.slice(0, match.start) + merged + hay.slice(match.end);
    expect(next).toContain("    baz();");
    expect(next).not.toContain("        baz();");
  });

  it("reports candidate line numbers for ambiguous line-trim matches", () => {
    const match = findBlockToReplace("  foo\n  bar\nother\n    foo\n    bar\n", "foo\nbar");
    expect(match).toEqual({
      ok: false,
      reason:
        "After line-trim comparison, searchBlock matches 2 regions at lines 1, 4; add more unique context lines.",
    });
  });
});

describe("applyBlockEdits", () => {
  it("@head avoids double newline when replacement already ends with LF", () => {
    const out = applyBlockEdits("export {}\n", [
      { searchBlock: "@head", replaceBlock: "import x from 'y';\n" },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.text.startsWith("import x from 'y';\nexport")).toBe(true);
    expect(out.text.startsWith("import x from 'y';\n\nexport")).toBe(false);
  });

  it("@end avoids redundant separator when replacement starts with LF", () => {
    const out = applyBlockEdits("a", [{ searchBlock: "@end", replaceBlock: "\nb" }]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.text).toBe("a\nb");
  });

  it("line_trim edit preserves indentation via replacement merge", () => {
    const out = applyBlockEdits("  x:\n    one\n", [{ searchBlock: "one", replaceBlock: "two" }]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.text).toBe("  x:\n    two\n");
  });

  it("applies two edits on CRLF source when ordered bottom-to-top", () => {
    const raw = "top\r\nmid\r\nbottom\r\n";
    const out = applyBlockEdits(raw, [
      { searchBlock: "bottom", replaceBlock: "BOT" },
      { searchBlock: "top", replaceBlock: "TOP" },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.text).toBe("TOP\nmid\nBOT\n");
  });

  it("reports every failed block instead of stopping at the first one", () => {
    const out = applyBlockEdits("same\nsame\nkeep\n", [
      { searchBlock: "same", replaceBlock: "changed" },
      { searchBlock: "missing", replaceBlock: "added" },
      { searchBlock: "keep", replaceBlock: "kept" },
    ]);

    expect(out).toEqual({
      ok: false,
      failures: [
        {
          failedIndex: 0,
          reason:
            "searchBlock matches 2 times exactly at lines 1, 2; narrow the snippet or add surrounding lines.",
        },
        {
          failedIndex: 1,
          reason:
            "searchBlock not found in file. Copy a contiguous chunk from read_file output (exact or same lines after trim).",
        },
      ],
    });
  });
});
