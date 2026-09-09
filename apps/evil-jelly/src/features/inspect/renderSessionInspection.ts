import type { SessionInspection, TurnInspection } from "./sessionInspection";

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

function turnLine(turn: TurnInspection): string {
  const usage = `${integer(turn.promptTokens)} prompt / ${integer(turn.completionTokens)} completion`;
  const tools = `${turn.toolCalls} tools / ${bytes(turn.toolOutputBytes)}`;
  const failures =
    turn.transportFailures > 0 ? ` / ${turn.transportFailures} transport failures` : "";
  return `- ${turn.turnId} [${turn.status}] ${turn.modelCalls} models, ${usage}, ${tools}, ${duration(turn.modelDurationMs)} model${failures}`;
}

export function renderSessionInspection(inspection: SessionInspection): string {
  const totals = inspection.totals;
  const lines = [
    `Session ${inspection.sessionId}`,
    `Title: ${inspection.title}`,
    `Status: ${inspection.status}`,
    `Workspace: ${inspection.workspaceRoot}`,
    `Turns: ${inspection.completedTurns} completed, ${inspection.inProgressTurns} in progress`,
    `Model: ${totals.modelCalls} calls, ${integer(totals.promptTokens)} prompt, ${integer(totals.completionTokens)} completion, ${integer(totals.reasoningTokens)} reasoning, ${integer(totals.cacheReadTokens)} cache read, ${duration(totals.modelDurationMs)}`,
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
    lines.push(
      `Budget checkpoint: ${integer(inspection.budgetCheckpoint.promptTokens)} prompt / ${integer(inspection.budgetCheckpoint.completionTokens)} completion / ${inspection.budgetCheckpoint.callCount} calls`,
    );
  }

  lines.push("", "Turns");
  if (inspection.turns.length === 0) lines.push("(none)");
  else lines.push(...inspection.turns.map(turnLine));

  if (inspection.warnings.length > 0) {
    lines.push("", "Warnings", ...inspection.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
