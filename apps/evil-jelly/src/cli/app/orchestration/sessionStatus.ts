/**
 * Session budget combination + `/status` formatting.
 *
 * The core BudgetState aggregate is a running sum scoped to the current runWith. A logical
 * session spans several runs across resume, so the displayed cumulative is the resumed base
 * (SessionMeta.budget) plus the current run's aggregate. lastContextTokens is NOT summed: it
 * is the most recent model call's input tokens, which approximates the live context window.
 */

import type { UsageStats } from "@rejelly/core";
import type { SessionBudget } from "../../../domains/session/repository/sessionStore";

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
  /** Most recent call's input tokens ≈ live context-window usage. */
  contextTokens: number;
  /** Cached portion of that call's input tokens (subset of contextTokens). */
  cacheReadTokens: number;
}

/**
 * Cumulative session budget = resumed base + current run aggregate. The last-call snapshot is
 * taken as-is (not added) since it represents current occupancy, not a running sum.
 */
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

/** Compact token count: 1234 -> "1.2k", 4_500_000 -> "4.5m". */
function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}m`;
}

/** Render the cost ledger. micro_usd is shown as USD; other units are passed through raw. */
function formatCosts(costs: Record<string, number>): string {
  const entries = Object.entries(costs).filter(([, v]) => v > 0);
  if (entries.length === 0) {
    return "0";
  }
  return entries
    .map(([unit, amount]) =>
      unit === "micro_usd" ? `$${(amount / 1_000_000).toFixed(4)}` : `${amount} ${unit}`,
    )
    .join(", ");
}

/**
 * One-line cumulative usage summary shown when leaving a session (`/clear`), e.g.
 * `Token usage: total=621,466 input=597,135 (+ 5,206,912 cached) output=24,331`.
 */
export function formatTokenUsageLine(budget: SessionBudget): string {
  const num = (n: number) => n.toLocaleString("en-US");
  const cachedSuffix =
    budget.cacheReadTokens > 0 ? ` (+ ${num(budget.cacheReadTokens)} cached)` : "";
  return `Token usage: total=${num(budget.totalTokens)} input=${num(budget.promptTokens)}${cachedSuffix} output=${num(budget.completionTokens)}`;
}

export interface SessionStatusInput {
  sessionId: string;
  workspace: string;
  turns: number;
  budget: SessionBudget;
  modelId: string;
  /** Model context-window limit (tokens) when known; enables remaining/percent display. */
  contextWindow?: number;
}

/** Multi-line markdown summary for the `/status` command. */
export function formatSessionStatus(input: SessionStatusInput): string {
  const { sessionId, workspace, turns, budget, modelId, contextWindow } = input;
  const used = budget.lastContextTokens;
  // Cached portion of the most recent call's input; only meaningful alongside a measured context.
  const cachedSuffix =
    used > 0 && budget.lastCacheReadTokens > 0
      ? ` · ${formatTokens(budget.lastCacheReadTokens)} cached`
      : "";

  let contextLine: string;
  if (used <= 0) {
    contextLine = "not measured yet (no model call this session)";
  } else if (contextWindow && contextWindow > 0) {
    const pct = Math.min(100, Math.round((used / contextWindow) * 100));
    const free = Math.max(0, contextWindow - used);
    contextLine = `${formatTokens(used)} / ${formatTokens(contextWindow)} (${pct}% used, ${formatTokens(free)} free)${cachedSuffix}`;
  } else {
    contextLine = `~${formatTokens(used)} tokens (last turn input; set OPENAI_CONTEXT_WINDOW to show remaining)${cachedSuffix}`;
  }

  const tokensLine =
    budget.cacheReadTokens > 0
      ? `  - Tokens: ${formatTokens(budget.totalTokens)} (prompt ${formatTokens(budget.promptTokens)} / completion ${formatTokens(budget.completionTokens)} / cached ${formatTokens(budget.cacheReadTokens)})`
      : `  - Tokens: ${formatTokens(budget.totalTokens)} (prompt ${formatTokens(budget.promptTokens)} / completion ${formatTokens(budget.completionTokens)})`;

  return [
    "**Session status**",
    "",
    `- Session: ${sessionId} (${turns} turns)`,
    `- Workspace: ${workspace}`,
    `- Model: ${modelId}`,
    `- Context window (approx): ${contextLine}`,
    "- Cumulative this session:",
    tokensLine,
    `  - Model calls: ${budget.callCount}`,
    `  - Cost: ${formatCosts(budget.costs)}`,
    "",
  ].join("\n");
}
