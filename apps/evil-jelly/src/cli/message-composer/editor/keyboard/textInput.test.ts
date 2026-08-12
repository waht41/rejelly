import { describe, expect, it } from "vitest";
import { looksBinary, stripControlChars } from "./textInput";

describe("terminal text input", () => {
  it("strips rendering control characters while preserving tabs and newlines", () => {
    expect(stripControlChars("a\u0000b\tc\nd\u007f")).toBe("ab\tc\nd");
  });

  it("recognizes binary clipboard input", () => {
    expect(looksBinary("image\u0001bytes")).toBe(true);
    expect(looksBinary("invalid � utf8")).toBe(true);
    expect(looksBinary("ordinary\ttext\n")).toBe(false);
  });
});
