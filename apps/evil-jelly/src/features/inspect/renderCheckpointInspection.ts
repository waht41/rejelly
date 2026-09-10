import type {
  InitialContextComponentInspection,
  InitialContextInspection,
} from "./checkpointInspection";

const LABEL_WIDTH = 36;

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function compactTokens(value: number): string {
  const absolute = Math.abs(value);
  const formatted =
    absolute >= 1_000
      ? `${(absolute / 1_000).toFixed(absolute >= 10_000 ? 1 : 2)}k`
      : integer(absolute);
  return `${value < 0 ? "-" : ""}${formatted}`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function row(component: InitialContextComponentInspection): string {
  const estimate =
    component.estimatedTokens === component.tokens
      ? ""
      : ` (raw ~${compactTokens(component.estimatedTokens)})`;
  return `${component.label.padEnd(LABEL_WIDTH)} ~${compactTokens(component.tokens).padStart(8)}  ${percentage(component.share).padStart(7)}${estimate}`;
}

export function renderInitialContextInspection(inspection: InitialContextInspection): string {
  const lines = [
    `Initial context                       ~${compactTokens(inspection.tokens)} reconciled tokens`,
    `Turn: ${inspection.turnId}`,
    `Checkpoint: ${inspection.address}`,
    `Provider input #1: ${integer(inspection.providerPromptTokens)} tokens`,
    `Current-Turn input before call: ~${integer(inspection.estimatedTurnInputTokens)} tokens`,
    `Named component estimate: ~${integer(inspection.estimatedNamedComponentTokens)} tokens`,
    `Reconciliation delta: ${inspection.reconciliationDeltaTokens >= 0 ? "+" : ""}${integer(inspection.reconciliationDeltaTokens)} tokens`,
    "",
    `${"component".padEnd(LABEL_WIDTH)}   tokens    share`,
    "--------------------------------------------------------",
    ...inspection.components.map(row),
  ];

  lines.push("", "Tool definitions (share of reconciled Tool definitions)");
  if (!inspection.toolDefinitions) {
    lines.push("  (per-Tool breakdown unavailable for this Session)");
  } else if (inspection.toolDefinitions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const definition of inspection.toolDefinitions) {
      lines.push(
        `  ${definition.name.padEnd(LABEL_WIDTH - 2)} ~${compactTokens(definition.tokens).padStart(8)}  ${percentage(definition.share).padStart(7)}`,
      );
    }
    const toolTotal = inspection.components.find(
      (component) => component.kind === "tool_definitions",
    );
    lines.push(
      `  ${"".padEnd(LABEL_WIDTH - 2)} --------`,
      `  ${"".padEnd(LABEL_WIDTH - 2)} ~${compactTokens(toolTotal?.tokens ?? 0).padStart(8)}`,
    );
  }

  if (inspection.warnings.length > 0) {
    lines.push("", "Warnings", ...inspection.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
