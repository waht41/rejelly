import { describe, expect, it } from "vitest";
import {
  compareStringsByCodeUnit,
  escapeRegexLiteral,
  normalizeNewlines,
  utf8Prefix,
} from "./string";

describe("escapeRegexLiteral", () => {
  it("escapes regular-expression metacharacters", () => {
    expect(escapeRegexLiteral("a+b")).toBe("a\\+b");
    expect(escapeRegexLiteral("foo.bar")).toBe("foo\\.bar");
  });
});

describe("normalizeNewlines", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("compareStringsByCodeUnit", () => {
  it("provides deterministic, locale-independent ordering", () => {
    expect(["z", "a", "ä", "A"].sort(compareStringsByCodeUnit)).toEqual(["A", "a", "z", "ä"]);
  });
});

describe("utf8Prefix", () => {
  it("bounds UTF-8 bytes without splitting Unicode characters", () => {
    expect(utf8Prefix("界😀tail", 0)).toBe("");
    expect(utf8Prefix("界😀tail", 2)).toBe("");
    expect(utf8Prefix("界😀tail", 3)).toBe("界");
    expect(utf8Prefix("界😀tail", 6)).toBe("界");
    expect(utf8Prefix("界😀tail", 7)).toBe("界😀");
    expect(utf8Prefix("界😀tail", 100)).toBe("界😀tail");
  });
});
