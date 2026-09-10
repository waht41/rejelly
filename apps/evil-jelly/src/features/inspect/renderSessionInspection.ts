import type { CompactionInspection, SessionInspection, TurnInspection } from "./sessionInspection";
import type { SessionTopContributor } from "./turnWaterfall";

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function duration(value: number): string {
  if (value < 1_000) return `${integer(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function compactInteger(value: number): string {
  if (Math.abs(value) < 1_000) return integer(value);
  if (Math.abs(value) < 1_000_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
}

function bytes(value: number): string {
  if (value < 1_024) return `${value}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)}MB`;
}

function percentage(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function multiplier(value: number): string {
  return `${value.toFixed(1)}x`;
}

const TURN_COLUMNS = [3, 16, 9, 5, 8, 7, 5, 8, 7, 6, 5, 8] as const;

function tableRow(values: readonly string[]): string {
  return values
    .map((value, index) => {
      const width = TURN_COLUMNS[index];
      const clipped = value.length <= width ? value : `${value.slice(0, width - 1)}…`;
      return index <= 2 ? clipped.padEnd(width) : clipped.padStart(width);
    })
    .join("  ");
}

function turnLine(turn: TurnInspection, turnNumber: number): string {
  return tableRow([
    String(turnNumber),
    turn.turnId,
    turn.status,
    String(turn.modelCalls),
    compactInteger(turn.prompt.cumulativeTokens),
    compactInteger(turn.prompt.peakInputTokens),
    compactInteger(
      turn.prompt.measuredCalls > 0 ? turn.prompt.cumulativeTokens / turn.prompt.measuredCalls : 0,
    ),
    compactInteger(turn.prompt.uncachedTokens),
    compactInteger(turn.completionTokens),
    percentage(turn.cacheHitRate),
    String(turn.toolCalls),
    duration(turn.modelDurationMs),
  ]);
}

function compactionLine(compaction: CompactionInspection): string {
  const tokenChange =
    compaction.beforeTokens !== undefined && compaction.afterTokens !== undefined
      ? (() => {
          const removed = compaction.beforeTokens - compaction.afterTokens;
          const reduction = compaction.beforeTokens > 0 ? removed / compaction.beforeTokens : 0;
          return `${integer(compaction.beforeTokens)} -> ${integer(compaction.afterTokens)} tokens (-${integer(removed)}, ${percentage(reduction)} reduction)`;
        })()
      : "token change unavailable";
  const messageChange = `${compaction.beforeMessageCount} -> ${compaction.afterMessageCount} messages`;
  const elapsed = compaction.durationMs !== undefined ? `, ${duration(compaction.durationMs)}` : "";
  const prefix = compaction.activeTurnId ? "  -" : "-";
  return `${prefix} Compact [${compaction.trigger}] ${tokenChange}, ${messageChange}${elapsed}`;
}

export function renderSessionInspection(
  inspection: SessionInspection,
  options: { topContributors?: readonly SessionTopContributor[] } = {},
): string {
  const totals = inspection.totals;
  const lines = [
    `Session ${inspection.sessionId}`,
    `Title: ${inspection.title}`,
    `Status: ${inspection.status}`,
    `Workspace: ${inspection.workspaceRoot}`,
    `Turns: ${inspection.completedTurns} completed, ${inspection.inProgressTurns} in progress`,
    `Model: ${totals.modelCalls} calls, ${integer(totals.completionTokens)} completion, ${integer(totals.reasoningTokens)} reasoning, ${duration(totals.modelDurationMs)}`,
    `Prompt: ${integer(totals.prompt.cumulativeTokens)} cumulative, ${integer(totals.prompt.peakInputTokens)} peak model input, ${multiplier(totals.prompt.amplification)} amplification, ${integer(totals.prompt.uncachedTokens)} uncached`,
    `Cache: ${integer(totals.cacheReadTokens)} read, ${integer(totals.cacheWriteTokens)} write, ${percentage(totals.cacheHitRate)} hit`,
    `Tools: ${totals.toolCalls} calls, ${bytes(totals.toolOutputBytes)} output, ${bytes(totals.canonicalToolResultBytes)} canonical, ${totals.transportFailures} transport failures, ${duration(totals.toolDurationMs)} summed execution`,
    `Compactions: ${totals.compactions}`,
  ];

  const costEntries = Object.entries(totals.costs);
  if (costEntries.length > 0) {
    lines.push(
      `Costs: ${costEntries.map(([unit, value]) => `${unit}=${integer(value)}`).join(", ")}`,
    );
  }
  if (inspection.budgetCheckpoint) {
    const budget = inspection.budgetCheckpoint;
    const budgetCacheHitRate =
      budget.promptTokens > 0 ? budget.cacheReadTokens / budget.promptTokens : 0;
    lines.push(
      `Budget checkpoint: ${integer(budget.promptTokens)} prompt / ${integer(budget.completionTokens)} completion / ${integer(budget.cacheReadTokens)} cache read / ${integer(budget.cacheWriteTokens)} cache write / ${percentage(budgetCacheHitRate)} cache hit / ${budget.callCount} calls`,
    );
  }

  lines.push("", "Turns");
  if (inspection.turns.length === 0) lines.push("(none)");
  else {
    const header = tableRow([
      "#",
      "turn",
      "status",
      "calls",
      "prompt",
      "peak",
      "avg",
      "uncached",
      "output",
      "hit",
      "tools",
      "time",
    ]);
    lines.push(
      header,
      "-".repeat(header.length),
      ...inspection.turns.map((turn, index) => turnLine(turn, index + 1)),
    );
  }

  if (inspection.compactions.length > 0) {
    lines.push("", "Compactions", ...inspection.compactions.map(compactionLine));
  }

  if (options.topContributors) {
    lines.push("", "Largest segments");
    if (options.topContributors.length === 0) lines.push("(none)");
    else {
      for (const contributor of options.topContributors) {
        const estimated = contributor.tokenSource === "estimated" ? "~" : "";
        const toolCall = contributor.toolCallId ? ` [${contributor.toolCallId}]` : "";
        lines.push(
          `- Turn ${contributor.turnNumber} #${contributor.address} ${contributor.label}${toolCall}: ${estimated}${integer(contributor.tokens)} tokens (${percentage(contributor.share)})`,
        );
      }
    }
  }

  if (inspection.warnings.length > 0) {
    lines.push("", "Warnings", ...inspection.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
