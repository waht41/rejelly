import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAndValidateJsonc, parseJsonc } from "./jsonc";

describe("parseJsonc", () => {
  it("parses line and block comments", () => {
    const input = `{
  // line comment
  "a": 1, /* block */ "b": 2
}`;
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });

  it("leaves comment-like content inside strings alone", () => {
    const input = `{ "url": "http://x/y", "glob": "a/*b*/c", "esc": "quote \\" // not a comment" }`;
    expect(parseJsonc(input)).toEqual({
      url: "http://x/y",
      glob: "a/*b*/c",
      esc: 'quote " // not a comment',
    });
  });

  it("allows trailing commas", () => {
    expect(parseJsonc(`{ "a": [1, 2,], }`)).toEqual({ a: [1, 2] });
  });

  it("throws with line/column info on malformed input", () => {
    expect(() => parseJsonc(`{\n  "a": nope\n}`)).toThrow(/at line 2, column \d+/);
  });

  it("throws instead of silently merging tokens split by a comment", () => {
    expect(() => parseJsonc(`[1/*c*/2]`)).toThrow();
  });

  it("throws on an unterminated block comment", () => {
    expect(() => parseJsonc(`{ "a": 1 } /* dangling`)).toThrow();
  });
});

describe("parseAndValidateJsonc", () => {
  const Schema = z.object({ value: z.string() });

  it("parses JSONC and validates with the provided schema", () => {
    expect(parseAndValidateJsonc(`{ "value": "ok" }`, "Config", "config.jsonc", Schema)).toEqual({
      value: "ok",
    });
  });

  it("wraps parse errors with the caller label and path", () => {
    expect(() => parseAndValidateJsonc("{ nope", "Config", "config.jsonc", Schema)).toThrow(
      /Config config\.jsonc is not valid JSON\(C\):/,
    );
  });

  it("wraps validation errors with the caller label and path", () => {
    expect(() => parseAndValidateJsonc(`{ "value": 1 }`, "Config", "config.jsonc", Schema)).toThrow(
      /Config config\.jsonc failed validation:/,
    );
  });
});
