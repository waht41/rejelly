/**
 * Memory Equipment Module
 *
 * Provides memory management capabilities for agents, allowing persistent state
 * storage across reborn cycles. This module includes:
 *
 * - equipMemory: Core hook for key-based state management (similar to React useState)
 * - equipMemo: Memoization hook built on top of equipMemory for caching async computations
 *
 * All memory values must be JSON-serializable and are automatically cloned to ensure
 * immutability. Memory persists across agent reborn cycles, making it suitable for
 * maintaining state between retries and iterations.
 *
 * @module equipMemory
 */

import { assertSerializable, isDepsDeepEqual, safeClone } from "../../../utils/object";
import type { Strict, Widen } from "../../../utils/type";
import { getCurrentContext } from "../../context/accessor";
import { INTERNAL_MEMO_PREFIX } from "./const";

// ============ Memory Equipment ============

/**
 * Equip memory (core hook)
 *
 * Similar to React useState, but key-based instead of order-based.
 * Memory persists across reborn cycles.
 *
 * **Restrictions**: Only JSON-serializable values allowed.
 * - ✅ string, number, boolean, null, plain object, array
 * - ❌ function, symbol, undefined, class instances (Date, Map, Set, etc.), circular references
 *
 * **Behavior**: Returns a snapshot (deep copy) of the stored value to prevent
 * direct mutations. All values are validated and cloned on read/write to ensure
 * immutability and serializability.
 *
 * @param key - Unique key for this memory slot
 * @param initialValue - Initial value if key doesn't exist (must be JSON serializable)
 * @returns Tuple of [currentValue, setValue]
 * @throws {Error} If value is not JSON serializable
 *
 * @example
 * const [attempts, setAttempts] = equipMemory('attempts', 0);
 *
 * if (attempts >= 3) {
 *   return { error: 'Max attempts reached' };
 * }
 *
 * // On failure, increment and reborn
 * setAttempts(attempts + 1);
 * return reborn();
 *
 * @example
 * // Functional update
 * const [history, setHistory] = equipMemory<string[]>('history', []);
 * setHistory(prev => [...prev, newItem]);
 *
 * @example
 * // ❌ These will throw Error
 * equipMemory('fn', () => {});           // function forbidden
 * equipMemory('date', new Date());        // class instance forbidden
 * equipMemory('map', new Map());          // class instance forbidden
 *
 * Type-level enforcement: initialValue uses Strict<T> (T inferred from the argument).
 * Strict<T> rejects undefined/Function/Symbol at compile time. The returned tuple uses
 * Widen<T> so literal initial values (e.g. 0) are exposed as number in the API.
 */
export function equipMemory<T>(
  key: string,
  initialValue: Strict<T>,
): [Widen<T>, (value: Widen<T> | ((prev: Widen<T>) => Widen<T>)) => void] {
  const ctx = getCurrentContext();

  // Initialize if not exists
  if (!ctx.memory.has(key)) {
    // Store cloned value to ensure it's serializable
    ctx.memory.set(key, safeClone(initialValue));
  }

  // Get current value and return a snapshot (deep copy)
  // This prevents users from directly mutating the stored value
  const rawValue = ctx.memory.get(key) as Widen<T>;
  const currentValue = safeClone(rawValue);

  // Setter function (supports functional update); value must satisfy Strict<T>
  const setValue = (value: Widen<T> | ((prev: Widen<T>) => Widen<T>)) => {
    // Get latest raw value (don't clone here, just read)
    const prevValue = ctx.memory.get(key) as Widen<T>;

    let newValue: Widen<T>;
    if (typeof value === "function") {
      // Functional update: pass a clone to prevent mutation
      newValue = (value as (prev: Widen<T>) => Widen<T>)(safeClone(prevValue));
    } else {
      newValue = value;
    }

    // Store cloned value to ensure it's serializable and break references
    ctx.memory.set(key, safeClone(newValue));
  };

  return [currentValue, setValue];
}

// ============ Ephemeral Equipment ============

/**
 * Equip ephemeral (internal hook for non-serializable data)
 *
 * Similar to equipMemory, but allows storing non-serializable values
 * (functions, objects, class instances, etc.). This is for internal use only
 * and is not exposed to users.
 *
 * **No restrictions**: Can store any value including functions, symbols, class instances, etc.
 *
 * **Behavior**: Returns the stored value directly (no cloning) to allow
 * direct mutations and preserve function references.
 *
 * **No functional update**: Setter accepts only T. If T is a function type, passing a new
 * function stores it as-is; we do not treat functions as "functional updater" to avoid
 * ambiguity (storing a callback would be wrongly executed as updater).
 *
 * @param key - Unique key for this ephemeral slot
 * @param initialValue - Initial value if key doesn't exist (can be any type)
 * @returns Tuple of [currentValue, setValue]
 *
 * @internal
 */
export function equipEphemeral<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const ctx = getCurrentContext();

  // Initialize if not exists (store directly, no cloning)
  if (!ctx.ephemeral.has(key)) {
    ctx.ephemeral.set(key, initialValue);
  }

  // Get current value and return directly (no cloning)
  const currentValue = ctx.ephemeral.get(key) as T;

  // Setter: only direct value (no functional update to avoid confusion when T is function)
  const setValue = (value: T) => {
    ctx.ephemeral.set(key, value);
  };

  return [currentValue, setValue];
}

/**
 * Cache entry structure for equipMemo
 */
interface MemoCache<T> {
  deps: unknown[];
  value: T;
}

// ============ Memo Equipment ============

/**
 * Equip memo (memoization hook)
 *
 * A syntax sugar built on top of equipMemory that provides memoization functionality.
 * Caches the result of an async factory function based on dependency array.
 * If dependencies haven't changed, returns cached value; otherwise executes factory and caches result.
 *
 * **Restrictions**: Cached value and deps must be strict JSON (no undefined/Function/Symbol).
 * Type-level enforcement: factory return type is Strict<T>; deps array type D is inferred and
 * checked with Strict<D> (no manual generic on deps). At runtime, deps are validated with
 * assertSerializable; invalid deps throw TypeError before the factory runs.
 *
 * **Deps comparison: deep.** Same structure (e.g. config/params objects) is treated as
 * unchanged, so you can pass inline objects and reduce boilerplate without extra refs.
 *
 * @param key - Unique key for this memo slot
 * @param factory - Async factory function that produces the value (return type enforces strict JSON)
 * @param deps - Dependency array for cache invalidation (must be strict JSON)
 * @returns Promise that resolves to the memoized value
 *
 * @example
 * // Memoize expensive computation
 * const result = await equipMemo(
 *   'expensive-computation',
 *   async () => {
 *     // Expensive async operation
 *     return await computeHeavyData(input);
 *   },
 *   [input.id, input.version]
 * );
 *
 * @example
 * // Memoize API call result
 * const userData = await equipMemo(
 *   'user-data',
 *   async () => await fetchUser(userId),
 *   [userId]
 * );
 */
export async function equipMemo<T, D extends readonly any[] = any[]>(
  key: string,
  factory: () => Promise<Strict<T>> | Strict<T>,
  deps: Strict<D>,
): Promise<T> {
  assertSerializable(deps, `equipMemo("${key}") deps`);

  // Get storage state
  // Structure: { deps: previous dependencies, value: previous computed result }
  const [cache, setCache] = equipMemory<MemoCache<T> | null>(`${INTERNAL_MEMO_PREFIX}${key}`, null);

  // Check if cache hit (memory-based cache)
  const hasChanged = !cache || !isDepsDeepEqual(cache.deps, deps as unknown[]);

  if (hasChanged) {
    // Cache miss: execute factory function
    const newValue = await factory();

    // Update storage
    setCache({
      deps: deps as unknown[],
      value: newValue as T,
    });

    return newValue as T;
  } else {
    // Cache hit: return cached value directly
    return cache.value;
  }
}
