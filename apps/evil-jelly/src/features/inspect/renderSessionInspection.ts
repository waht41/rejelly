import type { CompactionInspection, SessionInspection, TurnInspection } from "./sessionInspection";
import type { SessionTopContributor } from "./turnWaterfall";

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function duration(value: number): string {
  if (value < 1_000) return `${integer(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
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

function turnLine(turn: TurnInspection): string {
  const usage =
    `${integer(turn.prompt.cumulativeTokens)} cumulative prompt / ${integer(turn.prompt.peakInputTokens)} peak input / ` +
    `${multiplier(turn.prompt.amplification)} amplification / ~${integer(turn.prompt.replayedTokens)} replayed / ` +
    `${integer(turn.prompt.uncachedTokens)} uncached / ${integer(turn.completionTokens)} completion / ` +
    `${integer(turn.cacheReadTokens)} cache read (${percentage(turn.cacheHitRate)} hit)`;
  const tools = `${turn.toolCalls} tools / ${bytes(turn.toolOutputBytes)}`;
  const failures =
    turn.transportFailures > 0 ? ` / ${turn.transportFailures} transport failures` : "";
  return `${turn.turnId} [${turn.status}] ${turn.modelCalls} models, ${usage}, ${tools}, ${duration(turn.modelDurationMs)} model${failures}`;
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
    `Prompt: ${integer(totals.prompt.cumulativeTokens)} cumulative, ${integer(totals.prompt.peakInputTokens)} peak model input, ${multiplier(totals.prompt.amplification)} amplification, ~${integer(totals.prompt.replayedTokens)} replayed (${percentage(totals.prompt.replayShare)}), ${integer(totals.prompt.uncachedTokens)} uncached`,
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
  const timeline = [
    ...inspection.turns.map((turn, index) => ({
      seq: turn.firstSeq,
      line: `- ${index + 1}. ${turnLine(turn)}`,
    })),
    ...inspection.compactions.map((compaction) => ({
      seq: compaction.seq,
      line: compactionLine(compaction),
    })),
  ].sort((left, right) => left.seq - right.seq);
  if (timeline.length === 0) lines.push("(none)");
  else lines.push(...timeline.map((entry) => entry.line));

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
