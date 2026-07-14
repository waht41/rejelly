/**
 * Object Utilities
 *
 * Refactored for cohesion, performance, and type safety.
 * Sections: Guards & Validation, Safe Serialization, Immutability & Cloning, Stable Stringify, Comparison.
 */

import type { DeepReadonly } from "./type";

// ============ Guards & Validation ============

/**
 * Checks if a value is a plain object (created by {} or new Object()).
 * Strictly rejects generic class instances (Date, Map, custom classes).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export interface ValidationResult {
  valid: boolean;
  path?: string;
  reason?: string;
}

/**
 * Unified validation logic for JSON-serializable strictness.
 *
 * @param value - Value to check
 * @param path - Current path for error reporting (default "")
 * @param visited - Optional WeakSet for cycle detection (pass new WeakSet() to enable)
 */
export function validateSerializable(
  value: unknown,
  path = "",
  visited?: WeakSet<object>,
): ValidationResult {
  // 1. Primitives
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { valid: true };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { valid: false, path, reason: "Infinity/NaN" };
    }
    return { valid: true };
  }

  // 2. Invalid primitives
  if (value === undefined) return { valid: false, path, reason: "undefined" };
  if (typeof value === "symbol") return { valid: false, path, reason: "symbol" };
  if (typeof value === "bigint") return { valid: false, path, reason: "bigint" };
  if (typeof value === "function") return { valid: false, path, reason: "function" };

  // 3. Objects: optional cycle check
  // Explicit (value !== null) before WeakSet: WeakSet only accepts objects, adding null throws
  if (typeof value === "object" && value !== null) {
    if (visited?.has(value)) {
      return { valid: false, path, reason: "circular reference" };
    }
    visited?.add(value);
  }

  // 4. Arrays
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const nextPath = path ? `${path}[${i}]` : `[${i}]`;
      const res = validateSerializable(value[i], nextPath, visited);
      if (!res.valid) return res;
    }
    visited?.delete(value);
    return { valid: true };
  }

  // 5. Plain objects
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      const res = validateSerializable(value[key], nextPath, visited);
      if (!res.valid) return res;
    }
    visited?.delete(value);
    return { valid: true };
  }

  // 6. Complex types (Date, Map, Set, class instances)
  visited?.delete(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    const name = (value as object).constructor?.name ?? "unknown";
    return { valid: false, path, reason: `class:${name}` };
  }
  const tag = Object.prototype.toString.call(value);
  return { valid: false, path, reason: `unserializable type: ${tag}` };
}

/**
 * Assert that a value is JSON-serializable.
 * @throws {TypeError} If value contains non-serializable types
 */
export function assertSerializable(value: unknown, context: string): void {
  const res = validateSerializable(value, "", new WeakSet());
  if (!res.valid) {
    const pathInfo = res.path ? ` at "${res.path}"` : "";
    throw new TypeError(
      `${context}: Invalid serializable value${pathInfo}. Reason: ${res.reason}. ` +
        "Only JSON serializable values are allowed (string, number, boolean, null, plain object, array). " +
        "Functions, symbols, class instances (Date, Map, Set, etc.), and undefined are forbidden.",
    );
  }
}

/**
 * Check if a value is safe for Rejelly Memory Snapshot (strict JSON serializable, no cycles).
 */
export function isJSONSafe(value: unknown): boolean {
  return validateSerializable(value, "", new WeakSet()).valid;
}

/**
 * Recursively remove undefined values from an object/array so it is safe for metadata (e.g. JSON).
 * Returns undefined if the input is null/undefined; otherwise returns a cleaned copy.
 */
export function sanitizeUndefined<T>(obj: T): T | undefined {
  if (obj === undefined) return undefined;
  if (obj === null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeUndefined).filter((item) => item !== undefined) as unknown as T;
  }

  if (!isPlainObject(obj)) {
    return obj;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const cleaned = sanitizeUndefined(value);
    if (cleaned !== undefined) {
      result[key] = cleaned;
    }
  }
  return result as T;
}

// ============ Safe Serialization ============

/**
 * Ensure a value is fully JSON-serializable.
 * Non-serializable types are gracefully downgraded to descriptive strings
 * rather than being silently dropped, preserving debugging value for DevTools.
 */
export function sanitizeForJson(value: unknown, seen = new WeakSet()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return `${value.toString()}n`;

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular Reference]";
    seen.add(value);

    // Optional: support custom toJSON on objects
    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      const jsonVal = (value as { toJSON: () => unknown }).toJSON();
      seen.delete(value);
      return sanitizeForJson(jsonVal, seen);
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Error) return `[Error: ${value.message}]`;

    // Map: convert to array of [key, value] tuples so object keys are preserved (JSON object keys must be strings)
    if (value instanceof Map) {
      const sanitizedMap = Array.from(value.entries()).map(([k, v]) => [
        sanitizeForJson(k, seen),
        sanitizeForJson(v, seen),
      ]);
      seen.delete(value);
      return { __type: "Map", entries: sanitizedMap };
    }

    // Non-plain class instances: serialize as descriptive tag to avoid deep traversal traps
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype && !Array.isArray(value)) {
      return `[Instance of ${value.constructor?.name || "Object"}]`;
    }

    if (Array.isArray(value)) {
      const result = value.map((item) => sanitizeForJson(item, seen));
      seen.delete(value);
      return result;
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      sanitized[key] = sanitizeForJson((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return sanitized;
  }

  return "[Unknown Type]";
}

// ============ Immutability & Cloning ============

/**
 * Deep freeze an object (recursive Object.freeze).
 * Makes the object and all nested objects/arrays immutable.
 */
export function deepFreeze<T>(obj: T): DeepReadonly<T> {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj as DeepReadonly<T>;
  }
  if (Object.isFrozen(obj)) {
    return obj as DeepReadonly<T>;
  }

  Object.freeze(obj);

  if (Array.isArray(obj)) {
    obj.forEach((item) => {
      if (item && typeof item === "object" && !Object.isFrozen(item)) {
        deepFreeze(item);
      }
    });
  } else if (isPlainObject(obj)) {
    Object.values(obj).forEach((value) => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    });
  }

  return obj as DeepReadonly<T>;
}

/**
 * Deep clone for JSON-serializable values only.
 * Validates with assertSerializable first, then uses JSON parse/stringify.
 * For this guaranteed-JSON case, JSON path is often faster than structuredClone in V8 (Node/Chrome).
 */
export function safeClone<T>(value: T): T {
  assertSerializable(value, "safeClone");
  return JSON.parse(JSON.stringify(value)) as T;
}

// ============ Stable Stringify ============

/**
 * Stable stringify - JSON.stringify with sorted keys
 *
 * Ensures that objects with the same content but different key order
 * produce the same string representation.
 *
 * @param value - Value to stringify
 * @returns Stable JSON string
 *
 * @example
 * stableStringify({ a: 1, b: 2 }) === stableStringify({ b: 2, a: 1 }) // true
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => stableStringify(item));
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => {
      const val = (value as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${stableStringify(val)}`;
    });
    return `{${pairs.join(",")}}`;
  }

  return JSON.stringify(value);
}

// ============ Comparison ============

/**
 * Deep equality check.
 * Fast-fail on reference equality and distinct types.
 * Supports primitives, plain objects, arrays, Date, RegExp, and NaN.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return a === b;

  if (a && b && typeof a === "object" && typeof b === "object") {
    if (a.constructor !== b.constructor) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }

    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    if (a instanceof RegExp && b instanceof RegExp) {
      return a.source === b.source && a.flags === b.flags;
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!Object.hasOwn(b as object, key)) return false;
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Shallow equality for dependency arrays (React-style).
 * Used by equipResource: Object.is per element; reference change = deps changed.
 * Safe for non-serializable / side-effectful deps (no recursion, no cycle risk).
 */
export const isDepsShallowEqual = (deps1: unknown[] | null, deps2: unknown[] | null): boolean => {
  if (deps1 === deps2) return true;
  if (!deps1 || !deps2) return false;
  if (deps1.length !== deps2.length) return false;
  for (let i = 0; i < deps1.length; i++) {
    if (!Object.is(deps1[i], deps2[i])) return false;
  }
  return true;
};

/**
 * Deep equality for dependency arrays.
 * Used by equipMemo: same structure (e.g. config/params) = cache hit; reduces boilerplate.
 * Only for JSON-serializable deps (no cycle risk).
 */
export const isDepsDeepEqual = (deps1: unknown[], deps2: unknown[]): boolean => {
  return deepEqual(deps1, deps2);
};
