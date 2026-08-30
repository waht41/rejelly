import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { collapseDiffContext, layoutDiffLines, projectUnifiedDiff } from "./diffProjection";

describe("diff projection", () => {
  it("unquotes serialized Windows paths and collapses escaped separators", () => {
    const [file] = projectUnifiedDiff(
      '--- ".evil-jelly\\\\tmp\\\\old.txt"\n+++ ".evil-jelly\\\\tmp\\\\new.txt"\n@@ -1 +1 @@',
    );

    expect(file).toMatchObject({ text: ".evil-jelly\\tmp\\new.txt", kind: "file" });
  });

  it("wraps mixed CJK and Latin text by terminal cells with bounded continuation markers", () => {
    const addition = projectUnifiedDiff(`--- a\n+++ a\n@@ -1 +1 @@\n+中文 mixed content 中文`).find(
      (line) => line.kind === "addition",
    );
    const wrapped = layoutDiffLines([addition!], 10);

    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped[1]?.marker).toBe("↳ ");
    expect(wrapped.every((line) => stringWidth(line.text) <= 10)).toBe(true);
  });

  it("tracks old and new line numbers through additions and deletions", () => {
    const projected = projectUnifiedDiff(
      "--- a\n+++ a\n@@ -9,4 +9,4 @@\n before\n-old\n+new\n after\n tail",
    );
    const displayed = layoutDiffLines(projected, 40);

    expect(displayed.map((line) => line.text)).toEqual(
      expect.arrayContaining([" 9  9   before", "10    - old", "   10 + new", "11 11   after"]),
    );
  });

  it("folds anchoring context beyond three nearby lines", () => {
    const context = Array.from({ length: 8 }, (_, index) => ` before ${index + 1}`).join("\n");
    const projected = projectUnifiedDiff(`--- a\n+++ a\n@@ -1,9 +1,9 @@\n${context}\n-old\n+new`);
    const collapsed = collapseDiffContext(projected);

    expect(collapsed).toContainEqual({ text: "⋯ 5 unchanged lines", kind: "fold" });
    expect(collapsed.filter((line) => line.kind === "context")).toHaveLength(3);
  });
});
