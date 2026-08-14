/** Session usage accumulated across run segments. */

import type { UsageStats } from "@rejelly/core";
import type { SessionBudget } from "../../domains/session/model/sessionTypes";

export function emptySessionBudget(): SessionBudget {
  return {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    callCount: 0,
    costs: {},
    lastContextTokens: 0,
    lastCacheReadTokens: 0,
  };
}

/** Occupancy snapshot of the most recent model call (taken as-is, never summed). */
export interface LastCallSnapshot {
  contextTokens: number;
  cacheReadTokens: number;
}

export function combineSessionBudget(
  base: SessionBudget | undefined,
  runAggregate: UsageStats,
  last: LastCallSnapshot,
): SessionBudget {
  const costs: Record<string, number> = { ...(base?.costs ?? {}) };
  for (const [unit, amount] of Object.entries(runAggregate.costs ?? {})) {
    costs[unit] = (costs[unit] ?? 0) + amount;
  }
  return {
    totalTokens: (base?.totalTokens ?? 0) + runAggregate.totalTokens,
    promptTokens: (base?.promptTokens ?? 0) + runAggregate.promptTokens,
    completionTokens: (base?.completionTokens ?? 0) + runAggregate.completionTokens,
    cacheReadTokens: (base?.cacheReadTokens ?? 0) + (runAggregate.details?.cacheReadTokens ?? 0),
    callCount: (base?.callCount ?? 0) + runAggregate.callCount,
    costs,
    lastContextTokens: last.contextTokens,
    lastCacheReadTokens: last.cacheReadTokens,
  };
}
