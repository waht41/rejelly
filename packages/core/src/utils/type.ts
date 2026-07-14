/**
 * Shared type definitions (JSON, readonly, etc.)
 *
 * Kept in a separate module to avoid circular dependencies when other utils
 * or core modules need only these types.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// loose JSON, allow undefined
export type JsonPrimitiveLoose = JsonPrimitive | undefined;
export type JsonValueLoose =
  | JsonPrimitiveLoose
  | JsonValueLoose[]
  | { [key: string]: JsonValueLoose };
export type JsonObjectLoose = { [key: string]: JsonValueLoose };

/** Helper to strip readonly modifiers if needed */
export type Writable<T> = { -readonly [P in keyof T]: T[P] };

/**
 * Deep readonly: preserves tuple element types (unlike `ReadonlyArray<infer U>` which loses positions).
 */
export type DeepReadonly<T> = T extends readonly any[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Covers normal functions, arrow functions, and Class constructors.
 */
export type AnyFunction = ((...args: any[]) => any) | (abstract new (...args: any[]) => any);

/** Custom error message when strict validation fails */
type StrictJsonError =
  "Error: Only JSON-serializable types are allowed; functions, symbols, and other non-JSON values are not allowed";
/** Custom error message when loose validation fails */
type LooseJsonError =
  "Error: Only JSON-serializable types and undefined are allowed; functions, symbols, and other non-JSON values are not allowed";

/**
 * Non-JSON value: built-in types that mutate or lose data when JSON-serialized,
 * plus AnyFunction, symbol, and the strict error literal.
 */
export type NonJsonValue =
  | AnyFunction
  | symbol
  | Date
  | RegExp
  | Map<any, any>
  | Set<any>
  | WeakMap<any, any>
  | WeakSet<any>
  | Promise<any>
  | Error
  | ArrayBuffer
  | DataView;

/**
 * Zero tolerance: rejects undefined, Function, Symbol.
 */
export type EnforceStrictJson<T> = unknown extends T
  ? T // fast pass for top-level any/unknown, avoid false positive
  : [T] extends [JsonValue]
    ? T
    : T extends JsonPrimitive
      ? T
      : T extends NonJsonValue | undefined
        ? StrictJsonError
        : T extends readonly any[] // readonly array and tuple (e.g. as const) to avoid object-branch method checks
          ? { [K in keyof T]: EnforceStrictJson<T[K]> }
          : T extends object
            ? { [K in keyof T]: EnforceStrictJson<T[K]> }
            : StrictJsonError;

/**
 * Allows undefined; rejects Function and Symbol.
 */
export type EnforceLooseJson<T> = unknown extends T
  ? T // fast pass for top-level any/unknown, avoid false positive
  : [T] extends [JsonValueLoose]
    ? T
    : T extends JsonPrimitiveLoose
      ? T
      : T extends NonJsonValue
        ? LooseJsonError
        : T extends readonly any[] // readonly array and tuple (e.g. as const) to avoid object-branch method checks
          ? { [K in keyof T]: EnforceLooseJson<T[K]> }
          : T extends object
            ? { [K in keyof T]: EnforceLooseJson<T[K]> }
            : LooseJsonError;

/**
 * Helper type: enforces T to satisfy strict JSON (no undefined, functions, symbols, and other non-JSON values).
 * If T does not conform, TS reports an error via the intersection type conflict.
 */
export type Strict<T> = T extends EnforceStrictJson<T> ? T : StrictJsonError;

/**
 * Helper type: enforces T to satisfy loose JSON (undefined allowed; functions, symbols, and other non-JSON values are not allowed).
 */
export type Loose<T> = T extends EnforceLooseJson<T> ? T : LooseJsonError;

/** Widen literal types to their base primitive types (for public API surfaces). */
export type Widen<T> = T extends boolean
  ? boolean
  : T extends number
    ? number
    : T extends string
      ? string
      : T;

export type Awaitable<T> = T | Promise<T>;
