import { describe, expect, it } from "vitest";
import type { BufferState } from "../document/textBuffer";
import {
  caretDown,
  caretLeft,
  caretRight,
  caretUp,
  caretWordLeft,
  caretWordRight,
  deletePlaceholderOrChar,
  deleteWordLeftAtomic,
} from "./placeholderMotion";

const at = (text: string, cursor: number): BufferState => ({ text, cursor });

const PASTE = "[Pasted text #1 +13 lines]"; // 26 chars
const IMAGE = "[Image #1]"; // 10 chars

describe("caret motion across placeholders", () => {
  it("steps over a token instead of landing inside it", () => {
    const text = `a${PASTE}b`;
    // From the token's trailing edge, one ← clears the whole placeholder.
    expect(caretLeft(at(text, 27)).cursor).toBe(1);
    expect(caretRight(at(text, 1)).cursor).toBe(27);
    // Outside the token nothing changes.
    expect(caretLeft(at(text, 1)).cursor).toBe(0);
    expect(caretRight(at(text, 27)).cursor).toBe(28);
  });

  it("keeps word motion from stopping at the spaces inside a token", () => {
    const text = `hello ${PASTE} world`;
    // wordLeft alone would stop at "lines]" — inside the placeholder.
    expect(caretWordLeft(at(text, 32)).cursor).toBe(6);
    expect(caretWordRight(at(text, 6)).cursor).toBe(32);
  });

  it("snaps vertical motion to the nearer edge of a token", () => {
    // Arriving at column 3 of the token's line: the leading edge is nearer.
    expect(caretUp(at(`${IMAGE}\nxxxxxxxx`, 14)).cursor).toBe(0);
    expect(caretDown(at(`xxxxxxxx\n${IMAGE}`, 3)).cursor).toBe(9);
    // Column 8 sits deeper in, so the caret settles past the token instead.
    expect(caretDown(at(`xxxxxxxx\n${IMAGE}`, 8)).cursor).toBe(19);
  });

  it("leaves plain text motion untouched", () => {
    expect(caretLeft(at("abc", 2)).cursor).toBe(1);
    expect(caretRight(at("abc", 3)).cursor).toBe(3);
    expect(caretWordLeft(at("foo bar", 7)).cursor).toBe(4);
  });
});

describe("deletion across placeholders", () => {
  it("removes a whole placeholder on backspace", () => {
    expect(deletePlaceholderOrChar(at(`a${PASTE}`, 27))).toEqual({ text: "a", cursor: 1 });
    expect(deletePlaceholderOrChar(at(`a${IMAGE}`, 11))).toEqual({ text: "a", cursor: 1 });
  });

  it("removes a whole placeholder even if the caret got inside one", () => {
    expect(deletePlaceholderOrChar(at(`a${IMAGE}b`, 5))).toEqual({ text: "ab", cursor: 1 });
  });

  it("backspaces normally outside placeholders", () => {
    expect(deletePlaceholderOrChar(at("abc", 2))).toEqual({ text: "ac", cursor: 1 });
    expect(deletePlaceholderOrChar(at("abc", 0))).toEqual({ text: "abc", cursor: 0 });
  });

  it("deletes a whole placeholder on ctrl+w instead of shearing its tail", () => {
    // The bug: wordLeft stops at the space in "[Image #1]", leaving "[Image ".
    expect(deleteWordLeftAtomic(at(`hello ${IMAGE}`, 16))).toEqual({ text: "hello ", cursor: 6 });
    expect(deleteWordLeftAtomic(at(`hello ${PASTE}`, 32))).toEqual({ text: "hello ", cursor: 6 });
  });

  it("extends a word delete that would end inside a placeholder", () => {
    expect(deleteWordLeftAtomic(at(`hello ${IMAGE} `, 17))).toEqual({ text: "hello ", cursor: 6 });
  });

  it("deletes words normally outside placeholders", () => {
    expect(deleteWordLeftAtomic(at("foo bar baz", 7))).toEqual({ text: "foo  baz", cursor: 4 });
    expect(deleteWordLeftAtomic(at("foo", 0))).toEqual({ text: "foo", cursor: 0 });
  });
});
