import { describe, expect, it } from "vitest";
import {
  type BufferState,
  backspace,
  cursorRowCol,
  deleteToLineStart,
  deleteWordLeft,
  insert,
  moveDown,
  moveLineEnd,
  moveLineStart,
  moveUp,
  moveWordLeft,
  moveWordRight,
} from "./textBuffer";

const at = (text: string, cursor: number): BufferState => ({ text, cursor });

describe("textBuffer edits", () => {
  it("inserts at the caret and advances it", () => {
    expect(insert(at("ac", 1), "b")).toEqual({ text: "abc", cursor: 2 });
  });

  it("backspaces the char before the caret, no-op at start", () => {
    expect(backspace(at("abc", 2))).toEqual({ text: "ac", cursor: 1 });
    expect(backspace(at("abc", 0))).toEqual({ text: "abc", cursor: 0 });
  });

  it("deletes the word to the left", () => {
    expect(deleteWordLeft(at("foo bar baz", 7))).toEqual({ text: "foo  baz", cursor: 4 });
  });

  it("deletes to the start of the current line only", () => {
    expect(deleteToLineStart(at("a\nbcd", 4))).toEqual({ text: "a\nd", cursor: 2 });
  });
});

describe("textBuffer caret movement", () => {
  it("jumps by word over surrounding whitespace", () => {
    expect(moveWordLeft(at("foo bar", 7)).cursor).toBe(4);
    expect(moveWordLeft(at("foo bar", 4)).cursor).toBe(0);
    expect(moveWordRight(at("foo bar", 0)).cursor).toBe(3);
  });

  it("moves to line start/end within a multi-line buffer", () => {
    expect(moveLineStart(at("ab\ncde", 5)).cursor).toBe(3);
    expect(moveLineEnd(at("ab\ncde", 3)).cursor).toBe(6);
    expect(moveLineEnd(at("ab\ncde", 0)).cursor).toBe(2);
  });

  it("moves up/down keeping the column, clamped to shorter lines", () => {
    // caret at col 4 on line 1 ("world"), up to line 0 ("hi", len 2) clamps to col 2
    expect(moveUp(at("hi\nworld", 7)).cursor).toBe(2);
    // caret at col 1 on line 0, down to line 1 keeps col 1
    expect(moveDown(at("hi\nworld", 1)).cursor).toBe(4);
  });
});

describe("cursorRowCol", () => {
  it("reports row/col for the caret", () => {
    expect(cursorRowCol("hello", 3)).toEqual({ row: 0, col: 3 });
    expect(cursorRowCol("ab\ncde", 5)).toEqual({ row: 1, col: 2 });
    expect(cursorRowCol("ab\n", 3)).toEqual({ row: 1, col: 0 });
  });
});
