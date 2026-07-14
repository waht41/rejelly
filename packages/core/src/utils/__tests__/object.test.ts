/**
 * Object Utilities Tests
 *
 * Covers: isPlainObject, validateSerializable, assertSerializable, isJSONSafe,
 * sanitizeForJson, sanitizeUndefined, deepFreeze, safeClone, deepEqual, isDepsShallowEqual, isDepsDeepEqual.
 */

import { describe, expect, it } from "vitest";
import {
  assertSerializable,
  deepEqual,
  deepFreeze,
  isDepsDeepEqual,
  isDepsShallowEqual,
  isJSONSafe,
  isPlainObject,
  safeClone,
  sanitizeForJson,
  sanitizeUndefined,
  validateSerializable,
} from "../object";

describe("isPlainObject", () => {
  it("returns true for {} and Object()", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(new Object())).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns false for null and non-objects", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });

  it("returns false for arrays and class instances", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    expect(isPlainObject(/a/)).toBe(false);
    expect(isPlainObject(() => {})).toBe(false);
  });

  it("returns false for object with custom prototype", () => {
    const C = function (this: { x: number }) {
      this.x = 1;
    } as unknown as new () => { x: number };
    expect(isPlainObject(new C())).toBe(false);
  });
});

describe("validateSerializable", () => {
  describe("primitives", () => {
    it("allows null, string, boolean", () => {
      expect(validateSerializable(null)).toEqual({ valid: true });
      expect(validateSerializable("")).toEqual({ valid: true });
      expect(validateSerializable("x")).toEqual({ valid: true });
      expect(validateSerializable(true)).toEqual({ valid: true });
      expect(validateSerializable(false)).toEqual({ valid: true });
    });

    it("allows finite numbers", () => {
      expect(validateSerializable(0)).toEqual({ valid: true });
      expect(validateSerializable(1)).toEqual({ valid: true });
      expect(validateSerializable(-1)).toEqual({ valid: true });
    });

    it("rejects Infinity and NaN", () => {
      expect(validateSerializable(Infinity).valid).toBe(false);
      expect(validateSerializable(Infinity).reason).toBe("Infinity/NaN");
      expect(validateSerializable(-Infinity).valid).toBe(false);
      expect(validateSerializable(NaN).valid).toBe(false);
    });
  });

  describe("invalid primitives", () => {
    it("rejects undefined", () => {
      const res = validateSerializable(undefined);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("undefined");
    });

    it("rejects symbol, bigint, function", () => {
      expect(validateSerializable(Symbol("x")).reason).toBe("symbol");
      expect(validateSerializable(1n).reason).toBe("bigint");
      expect(validateSerializable(() => {}).reason).toBe("function");
    });
  });

  describe("arrays and plain objects", () => {
    it("allows empty and nested arrays/objects", () => {
      expect(validateSerializable([])).toEqual({ valid: true });
      expect(validateSerializable([1, "a", null])).toEqual({ valid: true });
      expect(validateSerializable({})).toEqual({ valid: true });
      expect(validateSerializable({ a: 1, b: { c: [] } })).toEqual({ valid: true });
    });

    it("reports path for invalid nested value", () => {
      const res = validateSerializable({ a: { b: undefined } });
      expect(res.valid).toBe(false);
      expect(res.path).toBe("a.b");
      expect(res.reason).toBe("undefined");
    });
  });

  describe("DAG (shared reference, no cycle)", () => {
    it("allows multiple properties referencing the same object", () => {
      const shared = { name: "test" };
      const validJsonData = { a: shared, b: shared };
      expect(validateSerializable(validJsonData, "", new WeakSet())).toEqual({ valid: true });
    });

    it("allows same object in array multiple times", () => {
      const shared = { x: 1 };
      expect(validateSerializable([shared, shared], "", new WeakSet())).toEqual({ valid: true });
    });
  });

  describe("circular reference", () => {
    it("rejects self-reference", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const res = validateSerializable(obj, "", new WeakSet());
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("circular reference");
    });

    it("rejects deeper cycle", () => {
      const a: Record<string, unknown> = {};
      const b = { parent: a };
      a.child = b;
      const res = validateSerializable(a, "", new WeakSet());
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("circular reference");
    });
  });

  describe("complex types", () => {
    it("rejects Date, Map, Set, RegExp", () => {
      expect(validateSerializable(new Date()).reason).toMatch(/^class:/);
      expect(validateSerializable(new Map()).reason).toMatch(/^class:/);
      expect(validateSerializable(new Set()).reason).toMatch(/^class:/);
      // RegExp is rejected (either as class or unserializable type depending on engine)
      expect(validateSerializable(/a/).valid).toBe(false);
    });
  });
});

describe("assertSerializable", () => {
  it("does not throw for valid value", () => {
    expect(() => assertSerializable({ a: 1 }, "test")).not.toThrow();
    expect(() => assertSerializable(null, "test")).not.toThrow();
  });

  it("throws TypeError with context and reason", () => {
    expect(() => assertSerializable(undefined, "safeClone")).toThrow(TypeError);
    expect(() => assertSerializable(undefined, "safeClone")).toThrow(/safeClone/);
    expect(() => assertSerializable(undefined, "safeClone")).toThrow(/undefined/);
  });
});

describe("isJSONSafe", () => {
  it("returns true for JSON-serializable values", () => {
    expect(isJSONSafe(null)).toBe(true);
    expect(isJSONSafe(1)).toBe(true);
    expect(isJSONSafe({ a: null })).toBe(true);
  });

  it("returns false for undefined, symbol, cycle", () => {
    expect(isJSONSafe(undefined)).toBe(false);
    expect(isJSONSafe(Symbol("x"))).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isJSONSafe(cycle)).toBe(false);
  });
});

describe("sanitizeForJson", () => {
  describe("circular reference", () => {
    it("replaces self-reference with [Circular Reference]", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      const out = sanitizeForJson(obj) as Record<string, unknown>;
      expect(out.self).toBe("[Circular Reference]");
      expect(out.a).toBe(1);
    });

    it("replaces deeper cycle with [Circular Reference]", () => {
      const a: Record<string, unknown> = { id: "a" };
      const b = { id: "b", parent: a };
      a.child = b;
      const out = sanitizeForJson(a) as Record<string, unknown>;
      const child = out.child as Record<string, unknown>;
      expect(child.parent).toBe("[Circular Reference]");
    });

    it("allows JSON.stringify of result without throwing", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const out = sanitizeForJson(obj);
      expect(() => JSON.stringify(out)).not.toThrow();
      expect(JSON.parse(JSON.stringify(out)).self).toBe("[Circular Reference]");
    });
  });

  describe("weird values", () => {
    it("sanitizes undefined, function, symbol, bigint", () => {
      expect(sanitizeForJson(undefined)).toBe("[undefined]");
      expect(sanitizeForJson(() => {})).toMatch(/^\[Function:/);
      expect(sanitizeForJson(Symbol("x"))).toBe("Symbol(x)");
      expect(sanitizeForJson(1n)).toBe("1n");
    });

    it("sanitizes Date and RegExp", () => {
      const d = new Date("2020-01-01T00:00:00.000Z");
      expect(sanitizeForJson(d)).toBe("2020-01-01T00:00:00.000Z");
      expect(sanitizeForJson(/a/g)).toBe("/a/g");
    });

    it("sanitizes Error as message string", () => {
      expect(sanitizeForJson(new Error("oops"))).toBe("[Error: oops]");
    });

    it("sanitizes Map as __type Map with entries array", () => {
      const m = new Map<string | number, string | number>([
        ["a", 1],
        [2, "two"],
      ]);
      const out = sanitizeForJson(m) as { __type: string; entries: unknown[] };
      expect(out.__type).toBe("Map");
      expect(out.entries).toEqual([
        ["a", 1],
        [2, "two"],
      ]);
    });

    it("sanitizes Map with object keys", () => {
      const key = { id: 1 };
      const m = new Map([[key, "val"]]);
      const out = sanitizeForJson(m) as { __type: string; entries: unknown[] };
      expect(out.__type).toBe("Map");
      expect(out.entries).toHaveLength(1);
      expect((out.entries[0] as unknown[])[0]).toEqual({ id: 1 });
      expect((out.entries[0] as unknown[])[1]).toBe("val");
    });

    it("sanitizes class instance as descriptive tag", () => {
      class Foo {}
      expect(sanitizeForJson(new Foo())).toBe("[Instance of Foo]");
    });

    it("primitives and plain objects/arrays pass through or deep copy", () => {
      expect(sanitizeForJson(null)).toBe(null);
      expect(sanitizeForJson(1)).toBe(1);
      expect(sanitizeForJson("x")).toBe("x");
      expect(sanitizeForJson(true)).toBe(true);
      expect(sanitizeForJson([1, 2])).toEqual([1, 2]);
      expect(sanitizeForJson({ a: 1 })).toEqual({ a: 1 });
    });
  });

  describe("immutability: modifying sanitized result does not affect original", () => {
    it("mutating sanitized object does not change original", () => {
      const original = { a: 1, b: { c: 2 } };
      const sanitized = sanitizeForJson(original) as Record<string, unknown>;
      (sanitized as Record<string, unknown>).a = 999;
      (sanitized.b as Record<string, unknown>).c = 888;
      expect(original).toEqual({ a: 1, b: { c: 2 } });
    });

    it("mutating sanitized array does not change original", () => {
      const original = [1, { x: 2 }];
      const sanitized = sanitizeForJson(original) as unknown[];
      sanitized[0] = 999;
      (sanitized[1] as Record<string, number>).x = 888;
      expect(original).toEqual([1, { x: 2 }]);
    });

    it("sanitized result is deep copy (no shared references with input)", () => {
      const original = { nested: { v: 1 } };
      const sanitized = sanitizeForJson(original) as { nested: { v: number } };
      expect(sanitized.nested).not.toBe(original.nested);
    });
  });
});

describe("sanitizeMetadata", () => {
  it("returns undefined for undefined, preserves null", () => {
    expect(sanitizeUndefined(null)).toBeNull();
    expect(sanitizeUndefined(undefined)).toBeUndefined();
  });

  it("returns primitives as-is", () => {
    expect(sanitizeUndefined(1)).toBe(1);
    expect(sanitizeUndefined("x")).toBe("x");
    expect(sanitizeUndefined(true)).toBe(true);
    expect(sanitizeUndefined(null)).toBeNull();
  });

  it("removes undefined from object", () => {
    expect(sanitizeUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("preserves null values in object", () => {
    expect(sanitizeUndefined({ a: 1, c: null })).toEqual({ a: 1, c: null });
  });

  it("removes undefined from array", () => {
    expect(sanitizeUndefined([1, undefined, 2])).toEqual([1, 2]);
  });

  it("recursively cleans nested structures", () => {
    const input = { a: { b: undefined, c: { d: undefined } }, e: 1 };
    expect(sanitizeUndefined(input)).toEqual({ a: { c: {} }, e: 1 });
  });
});

describe("deepFreeze", () => {
  it("returns primitives and null/undefined as-is", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
  });

  it("freezes object and nested objects/arrays", () => {
    const obj = { a: 1, nested: { b: 2 }, arr: [3] };
    const out = deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen((obj as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen((obj as { arr: unknown[] }).arr)).toBe(true);
    expect(out).toBe(obj);
  });

  it("is idempotent", () => {
    const obj = { a: 1 };
    deepFreeze(obj);
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it("prevents mutation", () => {
    const obj = { a: 1 };
    deepFreeze(obj);
    expect(() => {
      (obj as Record<string, number>).a = 2;
    }).toThrow();
  });
});

describe("safeClone", () => {
  it("deep clones plain object", () => {
    const src = { a: 1, b: { c: 2 } };
    const cloned = safeClone(src);
    expect(cloned).toEqual(src);
    expect(cloned).not.toBe(src);
    expect((cloned as { b: object }).b).not.toBe((src as { b: object }).b);
  });

  it("deep clones array", () => {
    const src = [1, { x: 2 }];
    const cloned = safeClone(src);
    expect(cloned).toEqual(src);
    expect(cloned).not.toBe(src);
    expect((cloned as object[])[1]).not.toBe((src as object[])[1]);
  });

  it("allows null and primitives", () => {
    expect(safeClone(null)).toBe(null);
    expect(safeClone(1)).toBe(1);
    expect(safeClone("x")).toBe("x");
  });

  it("throws on non-serializable value", () => {
    expect(() => safeClone(undefined)).toThrow(TypeError);
    expect(() => safeClone(new Date())).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => safeClone(cycle)).toThrow(TypeError);
  });
});

describe("deepEqual", () => {
  it("same reference is equal", () => {
    const o = {};
    expect(deepEqual(o, o)).toBe(true);
  });

  it("NaN equals NaN", () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
  });

  it("null/undefined handling", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, false)).toBe(false);
  });

  it("arrays", () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, { a: 1 }], [1, { a: 1 }])).toBe(true);
  });

  it("plain objects", () => {
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("Date and RegExp", () => {
    const d = new Date(123);
    expect(deepEqual(d, new Date(123))).toBe(true);
    expect(deepEqual(d, new Date(456))).toBe(false);
    expect(deepEqual(/a/g, /a/g)).toBe(true);
    expect(deepEqual(/a/g, /a/)).toBe(false);
  });
});

describe("isDepsShallowEqual", () => {
  it("uses shallow compare (Object.is per element)", () => {
    expect(isDepsShallowEqual([1, 2], [1, 2])).toBe(true);
    expect(isDepsShallowEqual([1], [1, 2])).toBe(false);
    const ref = [1];
    expect(isDepsShallowEqual([ref], [ref])).toBe(true);
    expect(isDepsShallowEqual([ref], [[1]])).toBe(false);
  });

  it("handles null (same reference or both null)", () => {
    expect(isDepsShallowEqual(null, null)).toBe(true);
    expect(isDepsShallowEqual([], null)).toBe(false);
    expect(isDepsShallowEqual(null, [])).toBe(false);
  });

  it("Object.is edge cases: NaN and +0/-0", () => {
    expect(isDepsShallowEqual([NaN], [NaN])).toBe(true);
    expect(isDepsShallowEqual([0], [-0])).toBe(false);
    expect(isDepsShallowEqual([-0], [-0])).toBe(true);
  });
});

describe("isDepsDeepEqual", () => {
  it("delegates to deepEqual for arrays", () => {
    expect(isDepsDeepEqual([1, 2], [1, 2])).toBe(true);
    expect(isDepsDeepEqual([1], [1, 2])).toBe(false);
    expect(isDepsDeepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });
});
