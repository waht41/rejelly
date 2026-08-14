import { describe, expect, it } from "vitest";
import { alignDeletionStart, tokenSpanAt, tokenSpanBefore } from "./placeholderText";

describe("placeholder token spans", () => {
  // "a" + "[Image #1]" (10 chars) + "b" + "[Pasted text #2 +9 lines]" (25 chars)
  const text = "a[Image #1]b[Pasted text #2 +9 lines]";

  it("finds the span strictly containing a position, for both token kinds", () => {
    expect(tokenSpanAt(text, 5)).toEqual({ start: 1, end: 11 });
    expect(tokenSpanAt(text, 20)).toEqual({ start: 12, end: 37 });
  });

  it("treats token edges as outside", () => {
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
