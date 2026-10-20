import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { answerAnchorRow, layoutAnswer, layoutPromptSummary } from "./layout";

describe("answer source layout", () => {
  it("preserves Markdown, code indentation, and blank lines", () => {
    const text = "## Answer\n\n```ts\n  const x = 1;\n```\n";
    expect(
      layoutAnswer(text, 80)
        .map((row) => row.text)
        .join("\n"),
    ).toBe(text);
  });

  it("wraps CJK and emoji by terminal cells without splitting graphemes", () => {
    const text = "中文👨‍👩‍👧‍👦é你好";
    const rows = layoutAnswer(text, 4);
    expect(rows.map((row) => row.text).join("")).toBe(text);
    expect(rows.every((row) => stringWidth(row.text) <= 4)).toBe(true);
    expect(rows.some((row) => row.text.includes("👨‍👩‍👧‍👦"))).toBe(true);
  });

  it("keeps a source anchor on the same passage after resize", () => {
    const text = "header\n" + "abcdefghijklmnopqrst";
    const before = layoutAnswer(text, 5);
    const anchor = before.find((row) => row.line === 1 && row.offset === 10)!;
    expect(anchor).toMatchObject({ line: 1, offset: 10, text: "klmno" });
    const after = layoutAnswer(text, 8);
    expect(after[answerAnchorRow(after, anchor)]).toEqual({ line: 1, offset: 8, text: "ijklmnop" });
  });

  it("sanitizes terminal controls and expands tabs without changing source storage", () => {
    const rows = layoutAnswer("\u001b[31mred\u001b[0m\r\n\tcode\u0007", 5);
    expect(rows.map((row) => row.text)).toEqual(["red", "    c", "ode"]);
    expect(rows.every((row) => stringWidth(row.text) <= 5)).toBe(true);
  });

  it("gives tab-expanded rows distinct anchors even in one-column terminals", () => {
    const rows = layoutAnswer("\tcode", 1);
    expect(rows.map((row) => row.offset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(answerAnchorRow(rows, rows[1]!)).toBe(1);
    const wider = layoutAnswer("\tcode", 4);
    expect(wider[answerAnchorRow(wider, rows[4]!)]?.text).toBe("code");
  });

  it("limits question previews to two rows, preserves newlines, and advertises full access", () => {
    expect(layoutPromptSummary("first\nsecond", 40)).toEqual(["You: first", "second"]);
    const question = `first\n${"中文👨‍👩‍👧‍👦".repeat(40)}\nlast`;
    for (const width of [1, 4, 5, 24, 40, 80]) {
      const rows = layoutPromptSummary(question, width);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => stringWidth(row) <= width)).toBe(true);
      expect(rows[1]).toContain("…");
      if (width >= 24) expect(rows[1]).toContain("p full question");
    }
  });

  it("handles empty and one-column viewports", () => {
    expect(layoutAnswer("", 0)).toEqual([{ text: "", line: 0, offset: 0 }]);
    expect(layoutAnswer("中a", 1).map((row) => row.text)).toEqual(["�", "a"]);
  });
});
