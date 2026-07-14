/**
 * Async Utilities with Implicit Signal Injection
 *
 * Wraps utils/async functions to automatically inject signal from current context.
 * Users don't need to manually pass signal - it's automatically retrieved from AgentContext.
 */

import {
  parallel as baseParallel,
  race as baseRace,
  retry as baseRetry,
  sleep as baseSleep,
  timeout as baseTimeout,
  waitUntil as baseWaitUntil,
  type ParallelOptions,
  type ParallelResult,
  type RaceOptions,
  type RetryOptions,
  type SleepOptions,
  type TimeoutOptions,
  type WaitUntilOptions,
} from "../../utils/async";
import { getCurrentContextSafe } from "../context/accessor";

// ============ Helper ============

/**
 * Get the AbortSignal from current AgentContext.
 * Returns undefined if called outside an agent context.
 */
export function getContextSignal(): AbortSignal | undefined {
  return getCurrentContextSafe()?.signal;
}

/**
 * Get an abort handle bound to current agent controller.
 * The returned closure can be called safely outside current ALS context.
 */
export function getAbortHandle(): (reason?: unknown) => void {
  const ctx = getCurrentContextSafe();
  if (!ctx) {
    return () => {};
  }

  const controller = ctx.controller;
  return (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
}

/**
 * Merge signal into options, preferring explicit signal over context signal
 */
function mergeSignal<T extends { signal?: AbortSignal }>(options?: T): T | undefined {
  const contextSignal = getContextSignal();

  if (!contextSignal && !options) {
    return undefined;
  }

  return {
    ...options,
    // Explicit signal takes precedence
    signal: options?.signal ?? contextSignal,
  } as T;
}

// ============ Sleep ============

/**
 * Sleep for specified milliseconds
 *
 * Abort-aware: will reject early if context signal or explicit signal is aborted.
 * Signal is automatically injected from current AgentContext.
 *
 * @param ms - Milliseconds to sleep
 * @param options - Sleep options (signal is auto-injected if not provided)
 *
 * @example
 * ```typescript
 * // Signal auto-injected from context
 * await sleep(1000)
 *
 * // Explicit signal overrides context signal
 * await sleep(1000, { signal: customController.signal })
 * ```
 */
export function sleep(ms: number, options?: SleepOptions): Promise<void> {
  return baseSleep(ms, mergeSignal(options));
}

// ============ Timeout ============

/**
 * Create a timeout promise
 *
 * Signal is automatically injected from current AgentContext.
 *
 * @param ms - Timeout in milliseconds
 * @param options - Timeout options (signal is auto-injected if not provided)
 *
 * @example
 * ```typescript
 * // Signal auto-injected from context
 * await Promise.race([fetchData(), timeout(5000)])
 *
 * // Explicit signal overrides context signal
 * await Promise.race([fetchData(), timeout(5000, { signal: customController.signal })])
 * ```
 */
export function timeout(ms: number, options?: TimeoutOptions): Promise<never> {
  return baseTimeout(ms, mergeSignal(options));
}

// ============ Retry ============

/**
 * Retry a function with exponential backoff
 *
 * Signal is automatically injected from current AgentContext.
 *
 * @param fn - Function to retry
 * @param options - Retry options (signal is auto-injected if not provided)
 *
 * @example
 * ```typescript
 * // Signal auto-injected from context
 * const result = await retry(() => fetchData(), { maxAttempts: 3 })
 *
 * // Explicit signal overrides context signal
 * const result = await retry(() => fetchData(), {
 *   maxAttempts: 3,
 *   signal: customController.signal
 * })
 * ```
 */
export async function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  return baseRetry(fn, mergeSignal(options));
}

// ============ Race ============
// NOTE: race, parallel, waitUntil are not exported yet (API not finalized)
// They are kept here for future use when the API is confirmed

/**
 * Race multiple promises with timeout
 *
 * Signal is automatically injected from current AgentContext.
 *
 * @internal
 */
async function _race<T>(promises: Promise<T>[], options: RaceOptions): Promise<T> {
  return baseRace(promises, mergeSignal(options)!);
}

// ============ Parallel ============

/**
 * Internal type helper for parallel results
 */
type ParallelResults<T extends readonly (() => unknown)[]> = {
  -readonly [K in keyof T]: T[K] extends () => infer R | Promise<infer R>
    ? ParallelResult<Awaited<R>>
    : never;
};

/**
 * Run tasks with concurrency limit
 *
 * Signal is automatically injected from current AgentContext.
 *
 * @internal
 */
async function _parallel<T extends readonly (() => unknown)[]>(
  tasks: [...T],
  options: ParallelOptions = {},
): Promise<[...ParallelResults<T>]> {
  return baseParallel(tasks, mergeSignal(options));
}

// ============ Wait Until ============

/**
 * Wait until condition is true
 *
 * Signal is automatically injected from current AgentContext.
 *
 * @internal
 */
async function _waitUntil(
  condition: () => boolean | Promise<boolean>,
  options?: WaitUntilOptions,
): Promise<void> {
  return baseWaitUntil(condition, mergeSignal(options));
}

// ============ Re-export Types ============

export type { SleepOptions, TimeoutOptions, RetryOptions };
