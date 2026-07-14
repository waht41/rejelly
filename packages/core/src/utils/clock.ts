/**
 * Clock Utilities
 *
 * Monotonic high-resolution timing for measuring durations.
 *
 * Use `startTimer()` for any elapsed-time / duration measurement: it reads from
 * the monotonic clock (`performance.now()`), so the result is immune to wall-clock
 * jumps (NTP adjustments, manual clock changes, leap-second smearing) that can make
 * `Date.now()`-based deltas go negative or wildly wrong.
 *
 * Do NOT use this for event timestamps, IDs, or anything that needs an epoch value —
 * `performance.now()` is an offset since process start, not a meaningful wall-clock
 * time. Keep using `Date.now()` for those.
 */

/**
 * Start a timer and return a function that yields the elapsed milliseconds since
 * this call. Both the start point and the diff use the monotonic clock, so callers
 * cannot accidentally mix time bases.
 *
 * @example
 *   const elapsed = startTimer();
 *   await doWork();
 *   const duration = elapsed();
 */
export function startTimer(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}
