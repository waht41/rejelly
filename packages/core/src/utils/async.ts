/**
 * Async Utilities
 *
 * Helper functions for async operations.
 * Users can wrap these with trace() for custom tracing.
 */

import { Semaphore } from "./concurrency";

// ============ Sleep ============

/**
 * Sleep options
 */
export interface SleepOptions {
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Sleep for specified milliseconds
 *
 * Abort-aware: will reject early if signal is aborted.
 *
 * @param ms - Milliseconds to sleep
 * @param options - Sleep options
 *
 * @example
 * ```typescript
 * // Normal sleep
 * await sleep(1000)
 *
 * // Sleep with abort signal
 * await sleep(1000, { signal: controller.signal })
 *
 * // With custom tracing
 * await trace('wait-for-api', async () => {
 *   await sleep(1000)
 * })
 * ```
 */
export function sleep(ms: number, options?: SleepOptions): Promise<void> {
  const { signal } = options ?? {};

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      resolve();
    }, ms);

    if (signal) {
      const abortHandler = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

// ============ Timeout ============

/**
 * Timeout options
 */
export interface TimeoutOptions {
  /** Error message (default: 'Timeout') */
  message?: string;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Create a timeout promise
 *
 * Abort-aware: will reject early if signal is aborted.
 *
 * @param ms - Timeout in milliseconds
 * @param options - Timeout options
 *
 * @example
 * ```typescript
 * // Normal timeout
 * await Promise.race([fetchData(), timeout(5000)])
 *
 * // With abort signal
 * await Promise.race([fetchData(), timeout(5000, { signal: controller.signal })])
 * ```
 */
export function timeout(ms: number, options?: TimeoutOptions): Promise<never> {
  const { message = "Timeout", signal } = options ?? {};

  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    if (signal) {
      const abortHandler = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

// ============ Retry ============

/**
 * Retry options
 */
export interface RetryOptions {
  /** Max attempts (default: 3) */
  maxAttempts?: number;
  /** Delay between attempts in ms (default: 1000) */
  delay?: number;
  /** Backoff multiplier (default: 2) */
  backoff?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Should retry predicate */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - Function to retry
 * @param options - Retry options
 *
 * @example
 * ```typescript
 * // With custom tracing
 * await trace('retry-api-call', async (span) => {
 *   const result = await retry(() => fetchData(), { maxAttempts: 3 })
 *   span.setAttribute('attempts', 3)
 *   return result
 * })
 * ```
 */
export async function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const {
    maxAttempts = 3,
    delay: initialDelay = 1000,
    backoff = 2,
    signal,
    shouldRetry = () => true,
  } = options ?? {};

  let lastError: Error | undefined;
  let currentDelay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;

      const willRetry = attempt < maxAttempts && shouldRetry(lastError, attempt);

      if (!willRetry) {
        throw lastError;
      }

      await sleep(currentDelay, { signal });
      currentDelay *= backoff;
    }
  }

  throw lastError;
}

// ============ Race ============

/**
 * Race options
 */
export interface RaceOptions {
  /** Timeout in milliseconds */
  timeout: number;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Race multiple promises with timeout
 *
 * Abort-aware: will reject early if signal is aborted.
 *
 * @param promises - Promises to race
 * @param options - Race options (timeout is required)
 *
 * @example
 * ```typescript
 * const result = await race([
 *   fetchFromServer1(),
 *   fetchFromServer2(),
 * ], { timeout: 5000 })
 *
 * // With abort signal
 * const result = await race([fetch1(), fetch2()], {
 *   timeout: 5000,
 *   signal: controller.signal
 * })
 *
 * // With custom tracing
 * await trace('fetch-race', async (span) => {
 *   const result = await race([fetch1(), fetch2()], { timeout: 5000 })
 *   span.setAttribute('winner', 'server1')
 *   return result
 * })
 * ```
 */
export async function race<T>(promises: Promise<T>[], options: RaceOptions): Promise<T> {
  const { timeout: timeoutMs, signal } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // Create abort promise if signal provided
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        const abortHandler = () => {
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  try {
    const racers: Promise<T | never>[] = [
      ...promises,
      timeout(timeoutMs).then(() => {
        throw { __timeout: true };
      }),
    ];

    if (abortPromise) {
      racers.push(abortPromise);
    }

    return await Promise.race(racers);
  } catch (error) {
    const timedOut = (error as { __timeout?: boolean }).__timeout === true;
    if (timedOut) {
      throw new Error("Timeout");
    }
    throw error;
  }
}

// ============ Parallel ============

/**
 * Parallel options
 */
export interface ParallelOptions {
  /** Max concurrent tasks (default: Infinity) */
  concurrency?: number;
  /** Whether to stop on first error (default: false) */
  stopOnError?: boolean;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Task timing information
 */
export interface TaskTiming {
  /** Task start timestamp (ms since epoch) */
  startTime: number;
  /** Task end timestamp (ms since epoch) */
  endTime: number;
  /** Task duration in milliseconds */
  duration: number;
}

/**
 * Parallel result for a single task
 */
export type ParallelResult<T> =
  | { status: "fulfilled"; value: T; index: number; timing: TaskTiming }
  | { status: "rejected"; reason: Error; index: number; timing: TaskTiming };

/**
 * Map task array to result array (supports heterogeneous return types)
 */
type ParallelResults<T extends readonly (() => unknown)[]> = {
  -readonly [K in keyof T]: T[K] extends () => infer R | Promise<infer R>
    ? ParallelResult<Awaited<R>>
    : never;
};

/**
 * Run tasks with concurrency limit
 *
 * Features:
 * - Uses Semaphore for concurrency control
 * - Supports stopOnError mode with early abort
 * - Supports heterogeneous return types (each task can return different type)
 * - Records timing info (startTime, endTime, duration) for each task
 *
 * @param tasks - Array of functions to execute (can return sync or async)
 * @param options - Parallel options (default: { concurrency: Infinity })
 * @returns Array of results in the same order as input tasks, each with timing info
 *
 * @example
 * ```typescript
 * // Run all tasks in parallel (no concurrency limit, default)
 * const results = await parallel([
 *   () => fetchUser(1),
 *   () => fetchUser(2),
 *   () => fetchUser(3),
 * ])
 *
 * // Run with concurrency limit of 5
 * const results = await parallel([
 *   () => fetchUser(1),
 *   () => fetchUser(2),
 *   () => fetchUser(3),
 * ], { concurrency: 5 })
 *
 * // Access timing information
 * for (const result of results) {
 *   console.log(`Task ${result.index}: ${result.timing.duration}ms`)
 *   console.log(`  Started: ${new Date(result.timing.startTime).toISOString()}`)
 *   console.log(`  Ended: ${new Date(result.timing.endTime).toISOString()}`)
 * }
 *
 * // With custom tracing
 * await trace('batch-fetch', async (span) => {
 *   const results = await parallel(tasks, { concurrency: 10 })
 *   span.setAttribute('success_count', results.filter(r => r.status === 'fulfilled').length)
 *   span.setAttribute('total_duration', Math.max(...results.map(r => r.timing.duration)))
 *   return results
 * })
 * ```
 */
export async function parallel<T extends readonly (() => unknown)[]>(
  tasks: [...T],
  options: ParallelOptions = {},
): Promise<[...ParallelResults<T>]> {
  const { concurrency = Infinity, stopOnError = false, signal } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // Cast tasks to unknown[] for internal processing
  const taskArray = tasks as (() => unknown)[];

  return runParallel(taskArray, concurrency, stopOnError, signal) as Promise<
    [...ParallelResults<T>]
  >;
}

/**
 * Safe task executor that handles both sync and async errors
 */
async function safeExecute(task: () => unknown): Promise<unknown> {
  // Wrap in Promise.resolve to catch sync errors
  return Promise.resolve().then(() => task());
}

/**
 * Internal parallel execution logic using Semaphore
 */
async function runParallel(
  tasks: (() => unknown)[],
  concurrency: number,
  stopOnError = false,
  externalSignal?: AbortSignal,
): Promise<ParallelResult<unknown>[]> {
  if (tasks.length === 0) {
    return [];
  }

  // Helper to check if aborted (external signal or internal controller)
  const isAborted = (internalSignal?: AbortSignal) =>
    externalSignal?.aborted || internalSignal?.aborted;

  // Helper to throw abort error
  const throwIfAborted = (internalSignal?: AbortSignal) => {
    if (externalSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (internalSignal?.aborted) {
      return true; // Internal abort from stopOnError, don't throw
    }
    return false;
  };

  // Concurrency >= task count - run all at once
  if (concurrency >= tasks.length) {
    const timedTasks = tasks.map(async (task, index) => {
      // Check external signal before starting
      if (externalSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const startTime = Date.now();
      try {
        const value = await safeExecute(task);
        const endTime = Date.now();
        return {
          status: "fulfilled" as const,
          value,
          index,
          timing: { startTime, endTime, duration: endTime - startTime },
        };
      } catch (error) {
        const endTime = Date.now();
        return {
          status: "rejected" as const,
          reason: error as Error,
          index,
          timing: { startTime, endTime, duration: endTime - startTime },
        };
      }
    });

    if (stopOnError) {
      // In stopOnError mode, we still need timing, so we wrap differently
      const results = await Promise.all(timedTasks);
      const firstRejected = results.find((r) => r.status === "rejected");
      if (firstRejected) {
        throw (firstRejected as { reason: Error }).reason;
      }
      return results;
    }

    return Promise.all(timedTasks);
  }

  // With concurrency limit - use Semaphore
  const semaphore = new Semaphore(concurrency);
  const results: ParallelResult<unknown>[] = new Array(tasks.length);

  // For stopOnError mode - internal controller
  const internalController = stopOnError ? new AbortController() : null;
  let firstError: Error | null = null;

  // Combined signal for semaphore acquire
  const getCombinedSignal = (): AbortSignal | undefined => {
    if (externalSignal && internalController) {
      // Create a combined abort controller
      const combined = new AbortController();
      const abortCombined = () => combined.abort();
      externalSignal.addEventListener("abort", abortCombined, { once: true });
      internalController.signal.addEventListener("abort", abortCombined, { once: true });
      return combined.signal;
    }
    return externalSignal ?? internalController?.signal;
  };

  const combinedSignal = getCombinedSignal();

  const executeTask = async (task: () => unknown, index: number): Promise<void> => {
    // Check if already aborted
    if (isAborted(internalController?.signal)) {
      if (throwIfAborted(internalController?.signal)) return;
    }

    await semaphore.acquire(combinedSignal);

    const startTime = Date.now();
    try {
      // Check again after acquiring (might have been aborted while waiting)
      if (isAborted(internalController?.signal)) {
        if (throwIfAborted(internalController?.signal)) return;
      }

      const value = await safeExecute(task);
      const endTime = Date.now();
      results[index] = {
        status: "fulfilled",
        value,
        index,
        timing: { startTime, endTime, duration: endTime - startTime },
      };
    } catch (error) {
      const endTime = Date.now();
      if (stopOnError && !firstError) {
        firstError = error as Error;
        internalController?.abort();
      }
      results[index] = {
        status: "rejected",
        reason: error as Error,
        index,
        timing: { startTime, endTime, duration: endTime - startTime },
      };
    } finally {
      semaphore.release();
    }
  };

  // Start all tasks (they will be throttled by semaphore)
  const promises = tasks.map((task, index) => executeTask(task, index));

  // Wait for all to complete (or abort in stopOnError mode)
  await Promise.all(promises);

  // Check external signal after completion
  if (externalSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // In stopOnError mode, throw the first error
  if (stopOnError && firstError) {
    throw firstError;
  }

  return results;
}

// ============ Wait Until ============

/**
 * Wait until options
 */
export interface WaitUntilOptions {
  /** Check interval in ms (default: 100) */
  interval?: number;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Wait until condition is true
 *
 * @param condition - Condition function
 * @param options - Wait options
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options?: WaitUntilOptions,
): Promise<void> {
  const { interval = 100, timeout: timeoutMs = 30000, signal } = options ?? {};

  const startTime = Date.now();

  while (true) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }

    if (Date.now() - startTime > timeoutMs) {
      throw new Error("Timeout waiting for condition");
    }

    if (await condition()) {
      return;
    }

    await sleep(interval, { signal });
  }
}
