/**
 * Safe JSON Parser Tests
 *
 * Tests for best-effort JSON parsing of incomplete streams
 */

import { describe, expect, it } from "vitest";
import { safeParse } from "../safe-json-parser";

describe("safeParse", () => {
  describe("valid JSON", () => {
    it("parses complete object", () => {
      expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    });

    it("parses complete array", () => {
      expect(safeParse("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("parses nested object", () => {
      expect(safeParse('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
    });

    it("parses with various types", () => {
      const json = '{"str":"hello","num":42,"bool":true,"null":null}';
      expect(safeParse(json)).toEqual({
        str: "hello",
        num: 42,
        bool: true,
        null: null,
      });
    });
  });

  describe("incomplete object", () => {
    it("handles incomplete key", () => {
      expect(safeParse('{"na')).toEqual({});
    });

    it("handles incomplete string value", () => {
      expect(safeParse('{"name":"Ali')).toEqual({ name: "Ali" });
    });

    it("handles incomplete number value", () => {
      expect(safeParse('{"age":2')).toEqual({ age: 2 });
    });

    it("handles missing closing brace", () => {
      expect(safeParse('{"a":1')).toEqual({ a: 1 });
    });

    it("handles trailing comma", () => {
      expect(safeParse('{"a":1,')).toEqual({ a: 1 });
    });

    it("handles incomplete nested object", () => {
      expect(safeParse('{"user":{"name":"Bob')).toEqual({ user: { name: "Bob" } });
    });
  });

  describe("incomplete array", () => {
    it("handles incomplete array", () => {
      expect(safeParse('["a","b')).toEqual(["a", "b"]);
    });

    it("handles missing closing bracket", () => {
      expect(safeParse("[1,2,3")).toEqual([1, 2, 3]);
    });

    it("handles trailing comma in array", () => {
      expect(safeParse("[1,2,")).toEqual([1, 2]);
    });

    it("handles nested incomplete array", () => {
      expect(safeParse('{"items":["a","b')).toEqual({ items: ["a", "b"] });
    });
  });

  describe("incomplete primitives", () => {
    it("handles incomplete true", () => {
      expect(safeParse('{"flag":tr')).toEqual({ flag: true });
    });

    it("handles incomplete false", () => {
      expect(safeParse('{"flag":fal')).toEqual({ flag: false });
    });

    it("handles incomplete null", () => {
      expect(safeParse('{"val":nu')).toEqual({ val: null });
    });

    it("does not truncate scientific notation at the exponent", () => {
      expect(safeParse('{"a":1e10')).toEqual({ a: 1e10 });
      expect(safeParse('{"a":1.5e-3')).toEqual({ a: 1.5e-3 });
      expect(safeParse('{"a":2E+5,"b":3')).toEqual({ a: 2e5, b: 3 });
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(safeParse("")).toBe("");
    });

    it("handles whitespace only", () => {
      expect(safeParse("   ")).toBe("");
    });

    it("handles just opening brace", () => {
      expect(safeParse("{")).toEqual({});
    });

    it("handles just opening bracket", () => {
      expect(safeParse("[")).toEqual([]);
    });

    it("handles deeply nested incomplete", () => {
      expect(safeParse('{"a":{"b":{"c":{"d":"val')).toEqual({
        a: { b: { c: { d: "val" } } },
      });
    });

    it("handles mixed incomplete structures", () => {
      expect(safeParse('{"users":[{"name":"Alice"},{"name":"Bo')).toEqual({
        users: [{ name: "Alice" }, { name: "Bo" }],
      });
    });

    it("handles string with escaped quotes", () => {
      expect(safeParse('{"msg":"hello \\"world')).toEqual({ msg: 'hello "world' });
    });

    it("handles unicode in strings", () => {
      expect(safeParse('{"emoji":"👋')).toEqual({ emoji: "👋" });
    });

    it("does not throw on a half-streamed \\uXXXX escape", () => {
      // Tail is `caf\u00` — an incomplete unicode escape. Must not throw (which
      // would collapse the whole object); the incomplete escape is dropped.
      expect(safeParse('{"response":"caf\\u00')).toEqual({ response: "caf" });
    });

    it("resolves the unicode escape once it is complete", () => {
      expect(safeParse('{"response":"caf\\u00e9')).toEqual({ response: "café" });
    });

    it("drops a lone trailing backslash without throwing", () => {
      expect(safeParse('{"response":"hello\\')).toEqual({ response: "hello" });
    });

    it("keeps a completed escaped backslash", () => {
      expect(safeParse('{"path":"a\\\\')).toEqual({ path: "a\\" });
    });

    it("suspends a lone high surrogate from a real emoji split mid-pair", () => {
      // "😀" is U+1F600 = surrogate pair 😀. Stop right after the high half.
      const high = String.fromCharCode(0xd83d);
      // Without suspension this would yield a lone surrogate (renders as �).
      expect(safeParse(`{"e":"x${high}`)).toEqual({ e: "x" });
      // Once the low half arrives the full emoji resolves.
      expect(safeParse(`{"e":"x${high}${String.fromCharCode(0xde00)}`)).toEqual({ e: "x😀" });
    });

    it("suspends a lone high surrogate written as a \\u escape", () => {
      expect(safeParse('{"e":"x\\uD83D')).toEqual({ e: "x" });
      expect(safeParse('{"e":"x\\uD83D\\uDE00')).toEqual({ e: "x😀" });
    });

    it("keeps a fully arrived emoji (no over-trimming)", () => {
      expect(safeParse('{"e":"👋')).toEqual({ e: "👋" });
    });
  });

  describe("fault tolerance (never collapses to {})", () => {
    it("does not throw on a closed string holding a raw control char", () => {
      // Raw backspace 0x08 is invalid in a JSON string; must not collapse the object.
      const bs = String.fromCharCode(8);
      expect(safeParse(`{"a":"x${bs}z","b":2}`)).toEqual({ a: `x${bs}z`, b: 2 });
    });

    it("does not throw on a closed string with an invalid escape", () => {
      // `\x` is not a valid JSON escape; the other field must still survive.
      const result = safeParse('{"a":"o\\xps","b":2}') as { b?: number };
      expect(result.b).toBe(2);
    });

    it("reads unknown literal values as strings instead of throwing", () => {
      expect(safeParse('{"a":NaN}')).toEqual({ a: "NaN" });
      expect(safeParse('{"a":undefined,"b":2}')).toEqual({ a: "undefined", b: 2 });
      expect(safeParse('{"a":Infinity}')).toEqual({ a: "Infinity" });
    });
  });

  describe("streaming simulation", () => {
    it("progressively parses stream", () => {
      const chunks = ['{"na', 'me":"', "Alice", '","ag', 'e":25}'];
      let accumulated = "";
      const results: any[] = [];

      for (const chunk of chunks) {
        accumulated += chunk;
        results.push(safeParse(accumulated));
      }

      // Early chunks may have partial data
      expect(results[0]).toEqual({});
      expect(results[1]).toEqual({ name: "" });
      expect(results[2]).toEqual({ name: "Alice" });
      expect(results[3]).toEqual({ name: "Alice" });
      expect(results[4]).toEqual({ name: "Alice", age: 25 });
    });

    it("never collapses to {} mid-stream across a unicode escape", () => {
      // Stream a value containing `é` written as `é`, one char at a time.
      const full = '{"response":"caf\\u00e9!"}';
      let accumulated = "";
      for (const ch of full) {
        accumulated += ch;
        const result = safeParse(accumulated) as { response?: string };
        // Once "response" has appeared, it must never disappear (no collapse to {})
        // and its already-emitted prefix must stay stable ("caf...").
        if (accumulated.includes('"response":"')) {
          expect(typeof result.response).toBe("string");
          expect("caf".startsWith((result.response ?? "").slice(0, 3))).toBe(true);
        }
      }
      expect(safeParse(full)).toEqual({ response: "café!" });
    });

    it("never emits a lone surrogate while a real emoji streams in", () => {
      // True only for an UNPAIRED surrogate; a complete pair (a normal emoji) is fine.
      const hasLoneSurrogate = (s: string): boolean => {
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // high without low
            i++; // skip the paired low half
          } else if (c >= 0xdc00 && c <= 0xdfff) {
            return true; // low without preceding high
          }
        }
        return false;
      };

      const full = '{"e":"hi😀!"}';
      let accumulated = "";
      for (const cu of full.split("")) {
        // split("") iterates UTF-16 code units, so the emoji's halves arrive separately
        accumulated += cu;
        const result = safeParse(accumulated) as { e?: string };
        if (typeof result.e === "string") {
          expect(hasLoneSurrogate(result.e)).toBe(false);
        }
      }
      expect(safeParse(full)).toEqual({ e: "hi😀!" });
    });

    it("never emits a lone surrogate while an escaped emoji (\\uD83D\\uDE00) streams in", () => {
      // The low surrogate's \uXXXX arrives over 6 chars (\, \u, \uD, \uDE, \uDE0);
      // every one of those mid-frames must suspend, not flash a lone high surrogate.
      const full = '{"e":"\\uD83D\\uDE00!"}';
      let accumulated = "";
      for (const ch of full) {
        accumulated += ch;
        const result = safeParse(accumulated) as { e?: string };
        if (typeof result.e === "string") {
          expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.e)).toBe(false);
        }
      }
      expect(safeParse(full)).toEqual({ e: "😀!" });
    });

    it("does NOT suspend grapheme refinement (thumbs-up gains a skin tone)", () => {
      // 👍 then the skin-tone modifier 🏽 (U+1F3FD). This is intentionally allowed to
      // mutate mid-stream: the base emoji is valid on its own, so we never withhold it.
      expect(safeParse('{"e":"👍')).toEqual({ e: "👍" });
      expect(safeParse('{"e":"👍🏽')).toEqual({ e: "👍🏽" });
    });
  });
});
