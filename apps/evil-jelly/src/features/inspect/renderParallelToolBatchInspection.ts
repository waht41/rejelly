import type { ParallelToolBatchInspection } from "./segmentInspection";

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function compactTokens(value: number): string {
  if (Math.abs(value) < 1_000) return integer(value);
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}k`;
}

function duration(value: number | undefined): string {
  if (value === undefined) return "-";
  return value < 1_000 ? `${integer(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function row(values: readonly string[], widths: readonly number[]): string {
  return values
    .map((value, index) =>
      index <= 1 ? value.padEnd(widths[index]) : value.padStart(widths[index]),
    )
    .join("  ");
}

export function renderParallelToolBatchInspection(inspection: ParallelToolBatchInspection): string {
  const titleAddresses = [inspection.requestGroupAddress, inspection.resultGroupAddress]
    .filter(Boolean)
    .map((address) => `#${address}`)
    .join(" / ");
  const lines = [
    `Parallel tool batch ${titleAddresses || `#${inspection.selectedAddress}`}`,
    `Turn: ${inspection.turnId}`,
    `Selected: ${inspection.selectedSide} #${inspection.selectedAddress}`,
    `Requests: ${inspection.requestGroupAddress ? `#${inspection.requestGroupAddress}` : "(unavailable)"}`,
    `Results: ${inspection.resultGroupAddress ? `#${inspection.resultGroupAddress}` : "(unavailable)"}`,
    "",
    `${inspection.calls.length} calls`,
    `Tokens: ~${compactTokens(inspection.totalTokens)}`,
  ];
  if (
    inspection.estimatedWallDurationMs !== undefined &&
    inspection.summedDurationMs !== undefined
  ) {
    lines.push(
      `Duration: ~${duration(inspection.estimatedWallDurationMs)} wall (max call) / ${duration(inspection.summedDurationMs)} summed`,
    );
  }

  const widths = [7, 20, 9, 9, 9, 10, 10];
  const header = row(["#", "tool", "request", "result", "total", "duration", "status"], widths);
  lines.push("", header, "-".repeat(header.length));
  for (const call of inspection.calls) {
    lines.push(
      row(
        [
          call.address,
          call.toolName,
          `~${compactTokens(call.requestTokens)}`,
          `~${compactTokens(call.resultTokens)}`,
          `~${compactTokens(call.totalTokens)}`,
          duration(call.durationMs),
          call.status,
        ],
        widths,
      ),
    );
  }

  if (
    inspection.contextBeforeRequests !== undefined ||
    inspection.contextAfterRequests !== undefined ||
    inspection.contextAfterResults !== undefined
  ) {
    lines.push("", "Context");
    if (inspection.contextBeforeRequests !== undefined)
      lines.push(`  before requests       ${integer(inspection.contextBeforeRequests)}`);
    if (inspection.contextAfterRequests !== undefined)
      lines.push(`  after requests        ${integer(inspection.contextAfterRequests)}`);
    if (inspection.contextAfterResults !== undefined)
      lines.push(`  after results         ${integer(inspection.contextAfterResults)}`);
    if (inspection.contextGrowth !== undefined)
      lines.push(`  growth               ~${compactTokens(inspection.contextGrowth)}`);
  }

  lines.push("", "Calls");
  for (const call of inspection.calls) {
    lines.push(`${call.address} ${call.toolName}`);
    if (call.requestPreview) lines.push(`  request: ${call.requestPreview}`);
    if (call.resultPreview) {
      const resultMeta = call.resultLines === undefined ? "" : `${call.resultLines} lines / `;
      lines.push(
        `  result: ${resultMeta}~${compactTokens(call.resultTokens)} tokens — ${call.resultPreview}`,
      );
    } else {
      lines.push("  result: (not persisted)");
    }
  }
  lines.push(
    "",
    `Select #${inspection.selectedAddress}.N for full Tool Call drill-down; use --payload only with a child address.`,
  );
  return lines.join("\n");
}
