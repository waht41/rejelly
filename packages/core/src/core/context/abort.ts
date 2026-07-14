/**
 * Abort Utilities
 *
 * Functions for checking and handling abort signals.
 */

import { AbortError } from "../domain/errors";
import { getCurrentContextSafe } from "./accessor";
import type { AgentContext } from "./type";

/**
 * Check if current context is aborted
 *
 * Throws AbortError if the current agent context has been aborted.
 *
 * @param ctx - Optional context to check. If not provided, uses getCurrentContextSafe()
 * @throws {AbortError} If current context is aborted
 *
 * @example
 * // Check abort in long-running loops
 * for (const item of items) {
 *   ensureActive(); // Throws if aborted
 *   await processItem(item);
 * }
 *
 * @example
 * // Use explicit context when outside AsyncLocalStorage scope
 * ensureActive(ctx); // Check specific context
 */
export function ensureActive(ctx?: AgentContext): void {
  let context = ctx ?? getCurrentContextSafe();
  if (!context) {
    return; // No context, nothing to check
  }

  // Loop through the entire context chain
  while (context) {
    // Check AbortSignal first (user manual cancellation)
    if (context.signal?.aborted) {
      throw AbortError.fromSignal(context.signal);
    }

    // Traverse upward
    context = context.parentContext;
  }
}
