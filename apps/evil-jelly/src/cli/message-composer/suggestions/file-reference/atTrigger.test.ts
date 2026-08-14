import { describe, expect, it } from "vitest";
import { activeAtTrigger, extractAtQuery, removeActiveAtTrigger } from "./atTrigger";

describe("extractAtQuery", () => {
  it("returns the token being typed at the caret", () => {
    expect(extractAtQuery("@src/too", 8)).toBe("src/too");
    expect(extractAtQuery("hello @foo", 10)).toBe("foo");
    expect(extractAtQuery("@", 1)).toBe("");
  });

  it("requires the @ to start the text or follow whitespace", () => {
    expect(extractAtQuery("foo@bar", 7)).toBeNull();
    expect(extractAtQuery("a\n@bar", 6)).toBe("bar");
  });

  it("finds an active token on a later multiline row", () => {
    const text = "first\nsecond\n@src";

    expect(extractAtQuery(text, text.length)).toBe("src");
  });

  it("treats a finalized (whitespace-followed) ref as inactive", () => {
    // caret after the trailing space → token closed
    expect(extractAtQuery("@src/foo.ts ", 12)).toBeNull();
    // caret in the middle of a finalized word → inactive
    expect(extractAtQuery("@src/foo.ts bar", 5)).toBeNull();
  });

  it("is active when the caret closes the token before whitespace", () => {
    expect(extractAtQuery("@src hello", 4)).toBe("src");
  });
});

describe("removeActiveAtTrigger", () => {
  it("removes the unfinished text trigger", () => {
    expect(removeActiveAtTrigger({ text: "hi @foo", cursor: 7 })).toEqual({
      text: "hi ",
      cursor: 3,
    });
  });
});

describe("activeAtTrigger", () => {
  it("returns the display range that should become a semantic file token", () => {
    expect(activeAtTrigger("see @src/ma", 11)).toEqual({
      start: 4,
      end: 11,
      query: "src/ma",
    });
    expect(activeAtTrigger("see @src/main.ts done", 21)).toBeNull();
  });
});
