import { describe, expect, it } from "vitest";
import { normalizeNewlines } from "./string";

describe("normalizeNewlines", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});
