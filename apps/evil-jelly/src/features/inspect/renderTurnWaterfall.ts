import type { TurnWaterfallChild, TurnWaterfallInspection } from "./turnWaterfall";

const BAR_WIDTH = 12;
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

function label(value: string, width = LABEL_WIDTH): string {
  return value.length <= width ? value.padEnd(width) : `${value.slice(0, width - 1)}…`;
}

function bar(tokens: number, positiveLargest: number, negativeLargest: number): string {
  const largest = tokens < 0 ? negativeLargest : positiveLargest;
  if (tokens === 0 || largest === 0) return "";
  const width = Math.max(1, Math.round((Math.abs(tokens) / largest) * BAR_WIDTH));
  return (tokens < 0 ? "<" : "#").repeat(width);
}

function values(
  tokens: number,
  tokenSource: "provider" | "estimated",
  contextTokens: number,
  contextSource: "provider" | "estimated",
): string {
  const estimated = tokenSource === "estimated" ? "~" : " ";
  const contextEstimated = contextSource === "estimated" ? "~" : " ";
  return `${estimated}${compactTokens(tokens).padStart(8)}  ${contextEstimated}${integer(contextTokens).padStart(9)}`;
}

function childLine(
  child: TurnWaterfallChild,
  last: boolean,
  positiveLargest: number,
  negativeLargest: number,
): string {
  return `     ${last ? "└─" : "├─"} ${label(child.label, LABEL_WIDTH - 3)} ${values(child.tokens, child.tokenSource, child.contextTokens, child.contextSource)}   ${bar(child.tokens, positiveLargest, negativeLargest)}`;
}

export function renderTurnWaterfall(inspection: TurnWaterfallInspection): string {
  const renderedTokens = inspection.segments.flatMap((segment) =>
    segment.children?.length
      ? segment.children.map((child) => child.tokens)
      : segment.kind === "reconciliation"
        ? []
        : [segment.tokens],
  );
  const positiveLargest = Math.max(0, ...renderedTokens.filter((tokens) => tokens > 0));
  const negativeLargest = Math.max(
    0,
    ...renderedTokens.filter((tokens) => tokens < 0).map(Math.abs),
  );
  const peakEstimated = inspection.peakContextSource === "estimated" ? "~" : "";
  const lines = [
    `Turn ${inspection.turnId}                     peak context ${peakEstimated}${compactTokens(inspection.peakContextTokens).slice(1)}`,
    `Session ${inspection.sessionId}  [${inspection.status}]`,
    "",
    " #   segment                                  tokens     context   size",
    " -------------------------------------------------------------------------------",
  ];
  inspection.segments.forEach((segment, index) => {
    if (segment.children?.length) {
      lines.push(`${String(index + 1).padStart(2)}   ┬ ${segment.label}`);
      segment.children.forEach((child, childIndex) => {
        lines.push(
          childLine(
            child,
            childIndex === segment.children!.length - 1,
            positiveLargest,
            negativeLargest,
          ),
        );
      });
      return;
    }
    const size =
      segment.kind === "reconciliation"
        ? ""
        : bar(segment.tokens, positiveLargest, negativeLargest);
    lines.push(
      `${String(index + 1).padStart(2)}   ${label(segment.label)} ${values(segment.tokens, segment.tokenSource, segment.contextTokens, segment.contextSource)}   ${size}`,
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
