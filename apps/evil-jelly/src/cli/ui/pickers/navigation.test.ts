import { describe, expect, it } from "vitest";
import { getVisibleWindow, wrapIndex } from "./navigation";

describe("picker navigation", () => {
  it("wraps selection indexes in both directions", () => {
    expect(wrapIndex(-1, 4)).toBe(3);
    expect(wrapIndex(4, 4)).toBe(0);
    expect(wrapIndex(0, 0)).toBe(0);
  });

  it("scrolls the visible window to keep a wrapped final item visible", () => {
    expect(getVisibleWindow({ selectedIndex: 19, itemCount: 20, visibleRowCount: 10 })).toEqual({
      start: 11,
      end: 20,
      resultRowCount: 9,
      aboveCount: 11,
      belowCount: 0,
    });
  });

  it("keeps the first page stable until selection moves past the rendered rows", () => {
    expect(getVisibleWindow({ selectedIndex: 8, itemCount: 20, visibleRowCount: 10 })).toEqual({
      start: 0,
      end: 9,
      resultRowCount: 9,
      aboveCount: 0,
      belowCount: 11,
    });
  });
});
