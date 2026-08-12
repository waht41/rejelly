import { describe, expect, it } from "vitest";
import {
  alignDeletionStart,
  coalescePaste,
  expandPastedTextTokens,
  PASTE_COALESCE_MS,
  type PasteRun,
  pastedTextToken,
  pastedTextTokenBefore,
  shouldCollapsePastedText,
  tokenSpanAt,
  tokenSpanBefore,
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

describe("placeholder token spans", () => {
  // "a" + "[Image #1]" (10 chars) + "b" + "[Pasted text #2 +9 lines]" (25 chars)
  const text = "a[Image #1]b[Pasted text #2 +9 lines]";

  it("finds the span strictly containing a position, both token kinds", () => {
    expect(tokenSpanAt(text, 5)).toEqual({ start: 1, end: 11 });
    expect(tokenSpanAt(text, 20)).toEqual({ start: 12, end: 37 });
  });

  it("treats the token edges as outside, so the caret can rest there", () => {
    expect(tokenSpanAt(text, 1)).toBe(null);
    expect(tokenSpanAt(text, 11)).toBe(null);
    expect(tokenSpanAt(text, 0)).toBe(null);
    expect(tokenSpanAt("no tokens here", 5)).toBe(null);
  });

  it("reports the span a backspace should swallow whole", () => {
    expect(tokenSpanBefore(text, 11)).toEqual({ start: 1, end: 11 });
    expect(tokenSpanBefore(text, 5)).toEqual({ start: 1, end: 11 });
    expect(tokenSpanBefore(text, 1)).toBe(null);
    expect(tokenSpanBefore(text, 12)).toBe(null);
  });

  it("pulls a deletion start back out of a token", () => {
    expect(alignDeletionStart(text, 5)).toBe(1);
    expect(alignDeletionStart(text, 11)).toBe(11);
    expect(alignDeletionStart(text, 0)).toBe(0);
  });
});

describe("coalescePaste", () => {
  const feed = (fragments: Array<{ text: string; at: number }>): PasteRun | null => {
    let run: PasteRun | null = null;
    let collapsedAt = -1;
    fragments.forEach((fragment, index) => {
      const result = coalescePaste(run, fragment.text, fragment.at, PASTE_COALESCE_MS);
      run = result.run;
      if (result.collapse && collapsedAt === -1) {
        collapsedAt = index;
      }
    });
    return run;
  };

  it("accumulates fragments that arrive within the window", () => {
    const chunk = "x".repeat(500);
    expect(coalescePaste(null, chunk, 0, PASTE_COALESCE_MS)).toEqual({
      run: { text: chunk, at: 0 },
      collapse: false,
    });
    const second = coalescePaste({ text: chunk, at: 0 }, chunk, 5, PASTE_COALESCE_MS);
    expect(second.run.text).toHaveLength(1000);
    expect(second.collapse).toBe(false);
  });

  it("collapses once the coalesced run crosses the char threshold", () => {
    const chunk = "x".repeat(700);
    const first = coalescePaste(null, chunk, 0, PASTE_COALESCE_MS);
    expect(first.collapse).toBe(false);
    const second = coalescePaste(first.run, chunk, 10, PASTE_COALESCE_MS);
    expect(second.run.text).toHaveLength(1400);
    expect(second.collapse).toBe(true);
  });

  it("collapses a burst of single characters (the Windows fragmented paste)", () => {
    const fragments = Array.from({ length: 1300 }, (_, index) => ({ text: "字", at: index }));
    const run = feed(fragments);
    // Each fragment lands 1ms after the last — well inside the window — so they
    // all fold into one run that crosses the char threshold.
    expect(run?.text.length).toBeGreaterThanOrEqual(1200);
  });

  it("resets the run when the gap exceeds the window (sustained typing)", () => {
    const chunk = "y".repeat(1100);
    const first = coalescePaste(null, chunk, 0, PASTE_COALESCE_MS);
    // Next keystroke arrives 200ms later — a human gap, so it starts fresh
    // instead of adding to the 1100-char run and wrongly collapsing.
    const second = coalescePaste(first.run, "z", 200, PASTE_COALESCE_MS);
    expect(second.run.text).toBe("z");
    expect(second.collapse).toBe(false);
  });

  it("coalesces newline fragments up to the line threshold", () => {
    const run = feed([
      { text: "a\nb\n", at: 0 },
      { text: "c\nd\n", at: 5 },
      { text: "e\nf", at: 10 },
    ]);
    expect(run && shouldCollapsePastedText(run.text)).toBe(true);
  });
});
