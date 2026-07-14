import { describe, expect, it } from "vitest";
import {
  expandPastedTextTokens,
  pastedTextToken,
  pastedTextTokenBefore,
  shouldCollapsePastedText,
} from "./lineText";

describe("collapsed pasted text", () => {
  it("collapses long multi-line pasted text", () => {
    expect(shouldCollapsePastedText("one\ntwo\nthree")).toBe(false);
    expect(shouldCollapsePastedText("1\n2\n3\n4\n5\n6")).toBe(true);
  });

  it("formats pasted text placeholders with line counts", () => {
    expect(pastedTextToken(2, "a\nb\nc")).toBe("[Pasted text #2 +3 lines]");
  });

  it("detects a pasted text token immediately before the caret", () => {
    const text = "prefix [Pasted text #3 +20 lines]";
    expect(pastedTextTokenBefore(text, text.length)).toBe("[Pasted text #3 +20 lines]");
    expect(pastedTextTokenBefore(`${text} suffix`, text.length + 1)).toBe(null);
  });

  it("expands live pasted text placeholders before submit", () => {
    const pasted = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6";
    const token = pastedTextToken(1, pasted);
    expect(expandPastedTextTokens(`before\n${token}\nafter`, [{ id: 1, text: pasted }])).toBe(
      `before\n${pasted}\nafter`,
    );
  });
});
