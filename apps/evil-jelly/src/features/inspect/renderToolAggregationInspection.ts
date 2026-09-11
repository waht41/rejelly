import type {
  AggregatedToolCall,
  GrepAggregateSummary,
  ToolAggregateSummary,
  ToolAggregationInspection,
} from "./toolAggregationInspection";

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function compact(value: number): string {
  if (value < 1_000) return integer(value);
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}k`;
}

function percentage(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(0)}%`;
}

function decimal(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(1);
}

function precisePercentage(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function duration(value: number): string {
  if (value < 1_000) return `${integer(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m${Math.round((value % 60_000) / 1_000)}s`;
}

function row(values: readonly string[], widths: readonly number[]): string {
  return values.map((value, index) => value.padStart(widths[index])).join("  ");
}

function renderAggregateTable(inspection: ToolAggregationInspection): string[] {
  const toolWidth = Math.max(4, ...inspection.tools.map((tool) => tool.toolName.length));
  const widths = [toolWidth, 6, 5, 9, 9, 10, 10, 9];
  const lines = [
    row(["tool", "calls", "ok", "request", "result", "avg result", "p95 result", "time"], widths),
    "-".repeat(widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 2),
  ];
  for (const tool of inspection.tools) {
    lines.push(
      row(
        [
          tool.toolName,
          integer(tool.calls),
          percentage(tool.successRate),
          compact(tool.requestTokens),
          compact(tool.resultTokens),
          compact(tool.averageResultTokens),
          compact(tool.p95ResultTokens),
          tool.durationSamples === 0 ? "-" : duration(tool.summedDurationMs),
        ],
        widths,
      ),
    );
  }
  if (inspection.scope === "turn") {
    const total = inspection.summary;
    lines.push(
      "",
      row(
        [
          "Total",
          integer(total.calls),
          percentage(total.successRate),
          compact(total.requestTokens),
          compact(total.resultTokens),
          compact(total.averageResultTokens),
          compact(total.p95ResultTokens),
          total.durationSamples === 0 ? "-" : duration(total.summedDurationMs),
        ],
        widths,
      ),
    );
  }
  return lines;
}

function callLabel(call: AggregatedToolCall, includeTool: boolean): string {
  const turn = call.turnNumber ? `T${call.turnNumber}` : (call.turnId ?? "-");
  return [turn, includeTool ? call.toolName : undefined, call.toolCallId]
    .filter(Boolean)
    .join("  ");
}

function renderCalls(
  title: string,
  calls: readonly AggregatedToolCall[],
  includeTool: boolean,
): string[] {
  if (calls.length === 0) return [];
  const labelWidth = Math.max(4, ...calls.map((call) => callLabel(call, includeTool).length));
  const widths = [labelWidth, 9, 7, 9, 10];
  return [
    title,
    row(["call", "result", "lines", "duration", "status"], widths),
    "-".repeat(widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 2),
    ...calls.map((call) =>
      row(
        [
          callLabel(call, includeTool),
          compact(call.resultTokens),
          integer(call.resultLines),
          call.durationMs === undefined ? "-" : duration(call.durationMs),
          call.status,
        ],
        widths,
      ),
    ),
  ];
}

function renderGrepCalls(title: string, calls: readonly AggregatedToolCall[]): string[] {
  if (calls.length === 0) return [];
  const labelWidth = Math.max(4, ...calls.map((call) => callLabel(call, false).length));
  const widths = [labelWidth, 9, 8, 7, 7, 5, 7, 9, 10];
  return [
    title,
    row(
      ["call", "result", "matches", "files", "lines", "ctx", "trunc", "duration", "status"],
      widths,
    ),
    "-".repeat(widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 2),
    ...calls.map((call) =>
      row(
        [
          callLabel(call, false),
          compact(call.resultTokens),
          call.grepSearch ? integer(call.grepSearch.matches) : "-",
          call.grepSearch ? integer(call.grepSearch.files) : "-",
          call.grepSearch ? integer(call.grepSearch.emittedLines) : integer(call.resultLines),
          call.grepSearch ? integer(call.grepSearch.contextLines) : "-",
          call.grepSearch?.truncated ? "yes" : "-",
          call.durationMs === undefined ? "-" : duration(call.durationMs),
          call.status,
        ],
        widths,
      ),
    ),
  ];
}

function renderGrepSummary(summary: GrepAggregateSummary, calls: number): string[] {
  const measuredHint =
    summary.measuredCalls < calls ? ` across ${summary.measuredCalls} measured calls` : "";
  const canonicalTruncated = calls - summary.canonicalComplete;
  const lines = [
    "Truncation",
    `  ${"tool output".padEnd(21)} ${integer(summary.toolTruncated)} / ${integer(summary.toolTruncationMeasuredCalls)} known   ${precisePercentage(summary.toolTruncationMeasuredCalls === 0 ? undefined : summary.toolTruncated / summary.toolTruncationMeasuredCalls)}`,
    `  ${"canonical admission".padEnd(21)} ${integer(canonicalTruncated)} / ${integer(calls)}   ${precisePercentage(calls === 0 ? undefined : canonicalTruncated / calls)}`,
    "",
    "Search output",
    `  matches              ${integer(summary.matches)} total / ${decimal(summary.averageMatches)} avg / ${integer(summary.p95Matches)} p95${measuredHint}`,
    `  files                ${integer(summary.files)} summed`,
    `  emitted lines        ${integer(summary.emittedLines)} total / ${decimal(summary.averageEmittedLines)} avg`,
    `  context lines        ${integer(summary.p50ContextLines)} p50 / ${integer(summary.p95ContextLines)} p95`,
  ];
  if (summary.omittedMatches > 0) {
    lines.push(`  omitted matches      ${integer(summary.omittedMatches)} known`);
  }
  if (summary.omittedMatchesMeasuredCalls < calls) {
    lines.push(
      `  metadata             ${integer(summary.omittedMatchesMeasuredCalls)} / ${integer(calls)} calls`,
    );
  }
  lines.push("", "Output expansion", `  lines / match        ${decimal(summary.linesPerMatch)}`);
  return lines;
}

function summaryLines(summary: ToolAggregateSummary): string[] {
  const ratio =
    summary.resultRequestRatio === undefined ? "-" : `${summary.resultRequestRatio.toFixed(2)}x`;
  return [
    `Calls                  ${integer(summary.calls)}`,
    `Succeeded              ${integer(summary.successful)}`,
    `Failed                 ${integer(summary.failed)}`,
    "",
    `Request tokens         ${compact(summary.requestTokens)}`,
    `Result tokens          ${compact(summary.resultTokens)}`,
    `Result / request       ${ratio}`,
    "",
    "Result size",
    `  average              ${compact(summary.averageResultTokens)}`,
    `  p50                  ${compact(summary.p50ResultTokens)}`,
    `  p95                  ${compact(summary.p95ResultTokens)}`,
    `  max                  ${compact(summary.maxResultTokens)}`,
    "",
    "Duration",
    `  summed               ${summary.durationSamples === 0 ? "-" : duration(summary.summedDurationMs)}`,
    `  wall                 ${summary.durationSamples === 0 ? "-" : duration(summary.wallDurationMs)}`,
    `  average              ${summary.durationSamples === 0 ? "-" : duration(summary.averageDurationMs)}`,
    `  p50                  ${summary.durationSamples === 0 ? "-" : duration(summary.p50DurationMs)}`,
    `  p95                  ${summary.durationSamples === 0 ? "-" : duration(summary.p95DurationMs)}`,
  ];
}

export function renderToolAggregation(inspection: ToolAggregationInspection): string {
  if (inspection.scope === "session" || inspection.scope === "turn") {
    const lines = [inspection.scope === "turn" ? `Tools — Turn ${inspection.turnId}` : "Tools"];
    if (inspection.tools.length === 0) return [...lines, "", "(none)"].join("\n");
    lines.push("", ...renderAggregateTable(inspection));
    if (inspection.unusedTools.length > 0) {
      lines.push(
        "",
        `Unused tools (${integer(inspection.unusedTools.length)})`,
        `  ${inspection.unusedTools.join(", ")}`,
      );
    }
    if (inspection.scope === "turn") {
      const largest = renderCalls("Largest results", inspection.largestCalls, true);
      if (largest.length > 0) lines.push("", ...largest);
    }
    lines.push(
      "",
      inspection.summary.durationSamples === 0
        ? "Time: unavailable"
        : `Time: ${duration(inspection.summary.summedDurationMs)} summed execution / ${duration(inspection.summary.wallDurationMs)} wall`,
    );
    return lines.join("\n");
  }

  const lines = [
    inspection.scope === "turn_tool"
      ? `Tool: ${inspection.toolName} — Turn ${inspection.turnId}`
      : `Tool: ${inspection.toolName}`,
    "",
    ...summaryLines(inspection.summary),
  ];
  if (inspection.grepSearch) {
    lines.push("", ...renderGrepSummary(inspection.grepSearch, inspection.summary.calls));
  } else {
    lines.push("", `Canonical truncation  ${percentage(inspection.summary.truncationRate)}`);
  }
  if (inspection.scope === "turn_tool") {
    const calls =
      inspection.toolName === "grep"
        ? renderGrepCalls("Calls", inspection.calls)
        : renderCalls("Calls", inspection.calls, false);
    if (calls.length > 0) lines.push("", ...calls);
  } else {
    const largest =
      inspection.toolName === "grep"
        ? renderGrepCalls("Largest calls", inspection.largestCalls)
        : renderCalls("Largest calls", inspection.largestCalls, false);
    if (largest.length > 0) lines.push("", ...largest);
  }
  const failed = renderCalls("Failed calls", inspection.failedCalls, false);
  if (failed.length > 0) lines.push("", ...failed);
  return lines.join("\n");
}
