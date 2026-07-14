/**
 * Reborn Mechanism
 *
 * The core mechanism for agent state management and re-execution.
 * Returns a special signal that triggers handler re-run while preserving memory.
 */

import type { RebornSignal } from "../../context/lifecycle";
import { REBORN_SIGNAL } from "../../shared/symbols";

/**
 * Check if a value is a RebornSignal
 *
 * @param value - Value to check
 * @returns true if value is a RebornSignal
 */
export function isRebornSignal(value: unknown): value is RebornSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    REBORN_SIGNAL in value &&
    (value as Record<symbol, unknown>)[REBORN_SIGNAL] === true
  );
}

/**
 * Trigger reborn - preserve memory, re-run handler
 *
 * Returns a special RebornSignal object. When the framework detects this
 * as handler's return value, it will:
 * 1. Reset draft state (equipTool, equipSystem, equipInstruction etc.)
 * 2. Re-execute handler with newProps (or current props)
 *
 * Note: Memory updates should be done using setState functions from equipMemory
 * before calling reborn(), not through reborn parameters.
 *
 * Compared to throwing an error, returning a signal:
 * - Won't be caught by try/catch accidentally
 * - Allows TypeScript to infer return type properly
 *
 * @param newProps - Optional new props (replaces current props if provided)
 * @returns RebornSignal - must be returned from handler
 *
 * @example
 * // Update memory using setState, then reborn
 * setAttempts(attempts + 1);
 * return reborn();
 *
 * @example
 * // Update props and reborn
 * return reborn({ topic: 'new topic' });
 *
 * @example
 * // No updates, just re-run (most common)
 * return reborn();
 */
export function reborn<Props = unknown>(newProps?: Props): RebornSignal<Props> {
  return {
    [REBORN_SIGNAL]: true as const,
    newProps,
  };
}
