import { describe, expect, it } from "vitest";
import { compareStringsByCodeUnit, normalizeNewlines } from "./string";

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
