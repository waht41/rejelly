import {
  projectTopContributors,
  type TurnWaterfallChild,
  type TurnWaterfallInspection,
} from "./turnWaterfall";

const BAR_WIDTH = 12;
const LABEL_WIDTH = 64;

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function multiplier(value: number): string {
  return `${value.toFixed(1)}x`;
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

function toolLabel(value: string, toolCallId?: string): string {
  return toolCallId ? `${value} [${toolCallId}]` : value;
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
  return `     ${last ? "└─" : "├─"} ${label(toolLabel(child.label, child.toolCallId), LABEL_WIDTH - 3)} ${values(child.tokens, child.tokenSource, child.contextTokens, child.contextSource)}   ${bar(child.tokens, positiveLargest, negativeLargest)}`;
}

export function renderTurnWaterfall(
  inspection: TurnWaterfallInspection,
  options: { top?: number } = {},
): string {
  const renderedTokens = inspection.segments.flatMap((segment) =>
    segment.children?.length ? segment.children.map((child) => child.tokens) : [segment.tokens],
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
    `Prompt: ${integer(inspection.prompt.cumulativeTokens)} cumulative across ${inspection.prompt.measuredCalls} measured calls / ${integer(inspection.prompt.peakInputTokens)} peak model input / ${multiplier(inspection.prompt.amplification)} amplification / ${integer(inspection.prompt.uncachedTokens)} uncached`,
    "",
    " #   segment                                                            tokens     context   size",
    " ---------------------------------------------------------------------------------------------------------",
  ];
  const [initialCheckpoint, ...laterCheckpoints] = inspection.checkpoints;
  if (initialCheckpoint) {
    const initialLabel =
      initialCheckpoint.adjustmentTokens >= 0
        ? `prior context + system/tools (model input ${initialCheckpoint.modelCallAddress})`
        : `model input ${initialCheckpoint.modelCallAddress} checkpoint adjustment`;
    lines.push(
      ` C1  ${label(initialLabel)} ${values(
        initialCheckpoint.adjustmentTokens,
        "estimated",
        Math.max(0, initialCheckpoint.adjustmentTokens),
        "estimated",
      )}`,
    );
  }

  let checkpointIndex = 0;
  const appendCheckpointsThrough = (seq: number): void => {
    while (
      checkpointIndex < laterCheckpoints.length &&
      laterCheckpoints[checkpointIndex].seq <= seq
    ) {
      const checkpoint = laterCheckpoints[checkpointIndex];
      const direction = checkpoint.adjustmentTokens >= 0 ? "+" : "";
      lines.push(
        `     ${label(`model input ${checkpoint.modelCallAddress} (Turn #${checkpoint.modelCallNumber}, adjust ${direction}${integer(checkpoint.adjustmentTokens)})`)} ${values(
          checkpoint.adjustmentTokens,
          "provider",
          checkpoint.promptTokens,
          "provider",
        )}`,
      );
      checkpointIndex += 1;
    }
  };

  inspection.segments.forEach((segment, index) => {
    appendCheckpointsThrough(segment.seq);
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
    lines.push(
      `${String(index + 1).padStart(2)}   ${label(toolLabel(segment.label, segment.toolCallId))} ${values(segment.tokens, segment.tokenSource, segment.contextTokens, segment.contextSource)}   ${bar(segment.tokens, positiveLargest, negativeLargest)}`,
    );
  });
  appendCheckpointsThrough(Number.POSITIVE_INFINITY);
  if (options.top !== undefined) {
    const contributors = projectTopContributors(inspection, options.top);
    lines.push("", "Largest segments", "");
    if (contributors.length === 0) lines.push("(none)");
    else {
      for (const contributor of contributors) {
        const estimated = contributor.tokenSource === "estimated" ? "~" : " ";
        const name = toolLabel(contributor.label, contributor.toolCallId);
        lines.push(
          ` #${contributor.address.padEnd(5)} ${label(name, 50)} ${estimated}${compactTokens(contributor.tokens).slice(1).padStart(8)}  ${(contributor.share * 100).toFixed(1).padStart(5)}%`,
        );
      }
    }
  }
  lines.push(
    "",
    "~ estimated from canonical message content; unmarked token counts are provider-reported.",
    "Model input checkpoints align the running estimate to provider-reported input; M-addresses are Session-global Model Call addresses.",
  );
  if (inspection.warnings.length > 0)
    lines.push("", "Warnings", ...inspection.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}
