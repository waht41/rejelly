import { describe, expect, it } from "vitest";
import { extractAtQuery, refsMissingFromText, replaceAtToken } from "./atTrigger";

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

describe("replaceAtToken", () => {
  it("replaces the active token with a closed @ref and trailing space", () => {
    expect(replaceAtToken({ text: "see @src/fo", cursor: 11 }, ["src/foo.ts"])).toEqual({
      text: "see @src/foo.ts ",
      cursor: 16,
    });
  });

  it("keeps following text and does not double the separator", () => {
    expect(replaceAtToken({ text: "@a end", cursor: 2 }, ["x.ts"])).toEqual({
      text: "@x.ts end",
      cursor: 5,
    });
  });

  it("removes the token when given no paths", () => {
    expect(replaceAtToken({ text: "hi @foo", cursor: 7 }, [])).toEqual({
      text: "hi ",
      cursor: 3,
    });
  });
});

describe("refsMissingFromText", () => {
  it("filters out paths already referenced", () => {
    expect(refsMissingFromText("see @a.ts", ["a.ts", "b.ts"])).toEqual(["b.ts"]);
  });
});
