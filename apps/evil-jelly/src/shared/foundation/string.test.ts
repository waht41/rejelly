import { describe, expect, it } from "vitest";
import { compareStringsByCodeUnit, escapeRegexLiteral, normalizeNewlines } from "./string";

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
