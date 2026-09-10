import type { TurnWaterfallInspection, TurnWaterfallSegment } from "./turnWaterfall";

const BAR_WIDTH = 20;
const LABEL_WIDTH = 38;

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function compactTokens(value: number): string {
  const absolute = Math.abs(value);
  const formatted =
    absolute >= 1_000
      ? `${(absolute / 1_000).toFixed(absolute >= 10_000 ? 1 : 2)}k`
      : integer(absolute);
  return `${value >= 0 ? "+" : "-"}${formatted}`;
}

function label(value: string): string {
  return value.length <= LABEL_WIDTH
    ? value.padEnd(LABEL_WIDTH)
    : `${value.slice(0, LABEL_WIDTH - 1)}…`;
}

function bar(segment: TurnWaterfallSegment, largest: number): string {
  if (segment.kind === "reconciliation" || segment.tokens === 0 || largest === 0) return "";
  const width = Math.max(1, Math.round((Math.abs(segment.tokens) / largest) * BAR_WIDTH));
  return (segment.tokens < 0 ? "░" : "█").repeat(width);
}

export function renderTurnWaterfall(inspection: TurnWaterfallInspection): string {
  const largest = Math.max(0, ...inspection.segments.map((segment) => Math.abs(segment.tokens)));
  const peakEstimated = inspection.peakContextSource === "estimated" ? "~" : "";
  const lines = [
    `Turn ${inspection.turnId}                     peak context ${peakEstimated}${compactTokens(inspection.peakContextTokens).slice(1)}`,
    `Session ${inspection.sessionId}  [${inspection.status}]`,
    "",
    " #   segment                                  tokens     context   size",
    " -------------------------------------------------------------------------------",
  ];
  inspection.segments.forEach((segment, index) => {
    const estimated = segment.tokenSource === "estimated" ? "~" : " ";
    const contextEstimated = segment.contextSource === "estimated" ? "~" : " ";
    lines.push(
      `${String(index + 1).padStart(2)}   ${label(segment.label)} ${estimated}${compactTokens(segment.tokens).padStart(8)}  ${contextEstimated}${integer(segment.contextTokens).padStart(9)}   ${bar(segment, largest)}`,
    );
  });
  lines.push(
    "",
    "~ estimated from canonical message content; unmarked token counts are provider-reported.",
    "Provider reconciliation rows align the running estimate to reported model input; they are not context mutations.",
  );
  if (inspection.warnings.length > 0)
    lines.push("", "Warnings", ...inspection.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}
