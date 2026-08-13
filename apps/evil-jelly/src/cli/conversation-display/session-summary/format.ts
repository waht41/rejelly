export interface SessionUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  callCount: number;
  costs: Record<string, number>;
  lastContextTokens: number;
  lastCacheReadTokens: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

function formatCosts(costs: Record<string, number>): string {
  const entries = Object.entries(costs).filter(([, value]) => value > 0);
  if (entries.length === 0) return "0";
  return entries
    .map(([unit, amount]) =>
      unit === "micro_usd" ? `$${(amount / 1_000_000).toFixed(4)}` : `${amount} ${unit}`,
    )
    .join(", ");
}

export function formatTokenUsageLine(budget: SessionUsageSummary): string {
  const num = (n: number) => n.toLocaleString("en-US");
  const cachedSuffix =
    budget.cacheReadTokens > 0 ? ` (+ ${num(budget.cacheReadTokens)} cached)` : "";
  return `Token usage: total=${num(budget.totalTokens)} input=${num(budget.promptTokens)}${cachedSuffix} output=${num(budget.completionTokens)}`;
}

export interface SessionStatusInput {
  sessionId: string;
  workspace: string;
  turns: number;
  budget: SessionUsageSummary;
  modelId: string;
  contextWindow?: number;
}

export function formatSessionStatus(input: SessionStatusInput): string {
  const { sessionId, workspace, turns, budget, modelId, contextWindow } = input;
  const used = budget.lastContextTokens;
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
