import type { InitialContextInspection } from "./checkpointInspection";

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

function row(label: string, tokens: number, share: number): string {
  return `${label.padEnd(LABEL_WIDTH)} ~${compactTokens(tokens).padStart(8)}  ${percentage(share).padStart(7)}`;
}

export function renderInitialContextInspection(inspection: InitialContextInspection): string {
  const lines = [
    `Initial context                       ~${compactTokens(inspection.tokens)} tokens`,
    `Turn: ${inspection.turnId}`,
    `Checkpoint: ${inspection.address}`,
    "",
    `${"component".padEnd(LABEL_WIDTH)}   tokens    share`,
    "--------------------------------------------------------",
    ...inspection.components.map((component) =>
      row(component.label, component.tokens, component.share),
    ),
  ];

  lines.push("", "Tool definitions");
  if (!inspection.toolDefinitions) {
    lines.push("  (per-Tool breakdown unavailable for this Session)");
  } else if (inspection.toolDefinitions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const definition of inspection.toolDefinitions) {
      lines.push(
        `  ${definition.name.padEnd(LABEL_WIDTH - 2)} ~${compactTokens(definition.tokens).padStart(8)}`,
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
