import { describe, expect, it } from "vitest";
import { replaceAtToken } from "../message-composer/suggestions/file-reference/atTrigger";
import { deletePlaceholderOrChar } from "./placeholderMotion";
import {
  documentLogicalLength,
  projectPromptDocument,
  replacePromptRange,
  textPromptDocument,
} from "./promptDocument";
import { caretCell, verticalCaretTarget, wrapRows } from "./softWrap";
import {
  applyProjectedTransform,
  type BufferState,
  backspace,
  cursorRowCol,
  deleteToLineStart,
  deleteWordLeft,
  insert,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  setProjectedCursor,
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

describe("rich document compatibility transforms", () => {
  const skill = {
    type: "token" as const,
    kind: "skill" as const,
    id: "skill-1",
    qualifiedName: "project:review",
    displayText: "$review",
  };
  const document = replacePromptRange(textPromptDocument("ab"), 1, 1, [skill]);

  it("moves across a rich token as one logical position", () => {
    const movedLeft = applyProjectedTransform(
      { document, cursor: 2, caretAffinity: "forward" },
      moveLeft,
      "left",
    );
    const movedRight = applyProjectedTransform(
      { document, cursor: 1, caretAffinity: "forward" },
      moveRight,
      "right",
    );

    expect(movedLeft.cursor).toBe(1);
    expect(movedRight.cursor).toBe(2);
  });

  it("expands a character deletion inside a token to the whole token", () => {
    const deleted = applyProjectedTransform(
      { document, cursor: 2, caretAffinity: "forward" },
      backspace,
    );

    expect(projectPromptDocument(deleted.document).text).toBe("ab");
    expect(deleted.cursor).toBe(1);
  });

  it("preserves semantic tokens while legacy Image placeholders keep their atomic deletion", () => {
    const withPlaceholder = replacePromptRange(document, 3, 3, [
      { type: "text", text: "[Image #1]" },
    ]);
    const deleted = applyProjectedTransform(
      { document: withPlaceholder, cursor: 13, caretAffinity: "forward" },
      deletePlaceholderOrChar,
    );

    expect(projectPromptDocument(deleted.document).text).toBe("a$reviewb");
    expect(deleted.cursor).toBe(3);
  });

  it("preserves semantic tokens when a legacy text trigger edits a later range", () => {
    const withAtQuery = replacePromptRange(document, 3, 3, [{ type: "text", text: " @sr" }]);
    const replaced = applyProjectedTransform(
      { document: withAtQuery, cursor: 7, caretAffinity: "forward" },
      (state) => replaceAtToken(state, ["src"]),
    );

    expect(projectPromptDocument(replaced.document).text).toBe("a$reviewb @src ");
    expect(replaced.cursor).toBe(9);
  });

  it("keeps a vertical token snap on the target side of a soft-wrap boundary", () => {
    const tokenRowDocument = replacePromptRange(textPromptDocument("1111111111\nxx"), 10, 10, [
      skill,
    ]);
    const projection = projectPromptDocument(tokenRowDocument);
    const rows = wrapRows(projection.text, 10);
    const target = verticalCaretTarget(rows, projection.text.length, -1, null)!;
    const moved = setProjectedCursor(
      {
        document: tokenRowDocument,
        cursor: documentLogicalLength(tokenRowDocument),
        caretAffinity: "forward",
      },
      target.cursor,
      "nearest",
      target.affinity,
    );
    const displayCursor = projection.logicalToDisplay(moved.cursor);

    expect(displayCursor).toBe(10);
    expect(moved.caretAffinity).toBe("forward");
    expect(caretCell(rows, displayCursor, moved.caretAffinity)).toEqual({ row: 1, col: 0 });
  });
});
