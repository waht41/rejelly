import { describe, expect, it } from "vitest";
import {
  coalescePaste,
  PASTE_COALESCE_MS,
  type PasteRun,
  shouldCollapsePastedText,
} from "./collapsedPaste";

describe("collapsed pasted text", () => {
  it("collapses long multi-line pasted text", () => {
    expect(shouldCollapsePastedText("one\ntwo\nthree")).toBe(false);
    expect(shouldCollapsePastedText("1\n2\n3\n4\n5\n6")).toBe(true);
  });
});

describe("coalescePaste", () => {
  const feed = (fragments: Array<{ text: string; at: number }>): PasteRun | null => {
    let run: PasteRun | null = null;
    for (const fragment of fragments) {
      run = coalescePaste(run, fragment.text, fragment.at, PASTE_COALESCE_MS).run;
    }
    return run;
  };

  it("accumulates fragments and collapses after the threshold", () => {
    const chunk = "x".repeat(700);
    const first = coalescePaste(null, chunk, 0, PASTE_COALESCE_MS);
    const second = coalescePaste(first.run, chunk, 10, PASTE_COALESCE_MS);
    expect(first.collapse).toBe(false);
    expect(second.run.text).toHaveLength(1400);
    expect(second.collapse).toBe(true);
  });

  it("accumulates fragments below the threshold", () => {
    const chunk = "x".repeat(500);
    expect(coalescePaste(null, chunk, 0, PASTE_COALESCE_MS)).toEqual({
      run: { text: chunk, at: 0 },
      collapse: false,
    });
    const second = coalescePaste({ text: chunk, at: 0 }, chunk, 5, PASTE_COALESCE_MS);
    expect(second.run.text).toHaveLength(1000);
    expect(second.collapse).toBe(false);
  });

  it("collapses a burst of single characters", () => {
    const run = feed(Array.from({ length: 1300 }, (_, index) => ({ text: "字", at: index })));
    expect(run?.text.length).toBeGreaterThanOrEqual(1200);
  });

  it("resets the run after a human typing gap", () => {
    const first = coalescePaste(null, "y".repeat(1100), 0, PASTE_COALESCE_MS);
    expect(coalescePaste(first.run, "z", 200, PASTE_COALESCE_MS)).toEqual({
      run: { text: "z", at: 200 },
      collapse: false,
    });
  });

  it("coalesces a fragmented multi-line paste", () => {
    const run = feed([
      { text: "a\nb\n", at: 0 },
      { text: "c\nd\n", at: 5 },
      { text: "e\nf", at: 10 },
    ]);
    expect(run && shouldCollapsePastedText(run.text)).toBe(true);
  });
});
