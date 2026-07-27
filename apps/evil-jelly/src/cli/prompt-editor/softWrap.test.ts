import { describe, expect, it } from "vitest";
import { caretCell, wrapRows } from "./softWrap";

const texts = (text: string, width: number) => wrapRows(text, width).map((row) => row.text);
const cell = (text: string, width: number, cursor: number) =>
  caretCell(wrapRows(text, width), cursor);

describe("wrapRows", () => {
  it("keeps every logical line one row when nothing overflows", () => {
    expect(texts("ab\ncd", 10)).toEqual(["ab", "cd"]);
  });

  it("soft-wraps on word boundaries", () => {
    expect(texts("hello world foo", 10)).toEqual(["hello ", "world foo"]);
  });

  it("hard-breaks a word longer than the width", () => {
    expect(texts("aaaaaaaaaaa", 4)).toEqual(["aaaa", "aaaa", "aaa"]);
  });

  it("wraps CJK by display width, not character count", () => {
    expect(texts("中文中文中文", 4)).toEqual(["中文", "中文", "中文"]);
  });

  it("leaves the text unwrapped when the width is not measured yet", () => {
    expect(texts("hello world foo", 0)).toEqual(["hello world foo"]);
  });

  it("keeps row starts as exact buffer offsets", () => {
    const text = "hello world foo\nbar";
    for (const row of wrapRows(text, 10)) {
      expect(text.slice(row.start, row.start + row.text.length)).toBe(row.text);
    }
  });
});

describe("caretCell", () => {
  it("stays on the logical row when the line fits", () => {
    expect(cell("hello", 10, 3)).toEqual({ row: 0, col: 3 });
  });

  it("follows the caret onto a wrapped continuation row", () => {
    // "hello " / "world foo" — offset 8 is the "r" of "world".
    expect(cell("hello world foo", 10, 8)).toEqual({ row: 1, col: 2 });
  });

  it("puts a caret on a wrap boundary at the start of the next row", () => {
    expect(cell("hello world foo", 10, 6)).toEqual({ row: 1, col: 0 });
  });

  it("counts CJK as two cells", () => {
    expect(cell("中文ab", 10, 3)).toEqual({ row: 0, col: 5 });
  });

  it("counts wrapped rows across logical lines", () => {
    // "hello " / "world foo" / "bar" — offset 16 is the start of "bar".
    expect(cell("hello world foo\nbar", 10, 16)).toEqual({ row: 2, col: 0 });
  });

  it("lands at the end of the buffer", () => {
    expect(cell("hello world foo", 10, 15)).toEqual({ row: 1, col: 9 });
  });

  it("is at the origin for an empty buffer", () => {
    expect(cell("", 10, 0)).toEqual({ row: 0, col: 0 });
  });
});
