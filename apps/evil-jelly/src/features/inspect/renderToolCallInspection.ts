import type { ToolCallInspection, ToolCallPayloadInspection } from "./toolCallInspection";

const PREVIEW_LINES = 40;

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function compactTokens(value: number): string {
  if (value < 1_000) return integer(value);
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}k`;
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function duration(value: number): string {
  return value < 1_000 ? `${integer(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function prettyArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function preview(value: string, full: boolean): { text: string; shown: number; total: number } {
  const lines = value.length === 0 ? [] : value.split(/\r?\n/);
  const shown = full ? lines.length : Math.min(lines.length, PREVIEW_LINES);
  return { text: lines.slice(0, shown).join("\n"), shown, total: lines.length };
}

function tokenLine(
  name: string,
  payload: ToolCallPayloadInspection | undefined,
): string | undefined {
  if (payload?.tokens === undefined) return undefined;
  const estimated = payload.tokenSource === "estimated" ? "~" : "";
  const address = payload.address ? ` (#${payload.address})` : "";
  return `  ${name.padEnd(8)} ${estimated}${compactTokens(payload.tokens).padStart(8)}${address}`;
}

export function renderToolCallInspection(
  inspection: ToolCallInspection,
  options: { full?: boolean } = {},
): string {
  const requestTokens = tokenLine("request", inspection.request);
  const resultTokens = tokenLine("result", inspection.result);
  const contextStart = inspection.request?.contextBefore ?? inspection.result?.contextBefore;
  const contextEnd = inspection.result?.contextAfter ?? inspection.request?.contextAfter;
  const selectedAddress =
    inspection.selectedSide === "request"
      ? inspection.request?.address
      : inspection.result?.address;
  const fallbackAddress = inspection.result?.address ?? inspection.request?.address;
  const lines = [
    `Tool call ${(selectedAddress ?? fallbackAddress) ? `#${selectedAddress ?? fallbackAddress}` : ""}`.trimEnd(),
    `Session: ${inspection.sessionId}`,
    `Turn: ${inspection.turnNumber ?? "-"} (${inspection.turnId})`,
    `Tool: ${inspection.toolName}`,
    `Call: ${inspection.toolCallId}`,
    `Status: ${inspection.status}`,
  ];
  if (inspection.durationMs !== undefined)
    lines.push(`Duration: ${duration(inspection.durationMs)}`);
  lines.push("", "Tokens");
  if (requestTokens) lines.push(requestTokens);
  if (resultTokens) lines.push(resultTokens);
  lines.push(`  total    ${compactTokens(inspection.totalTokens).padStart(8)}`);
  if (contextStart !== undefined && contextEnd !== undefined) {
    lines.push(`  context  ${integer(contextStart)} -> ${integer(contextEnd)}`);
  }

  const resultPreview = inspection.result
    ? preview(inspection.result.content, options.full ?? false)
    : undefined;
  if (inspection.grepSearch) {
    const search = inspection.grepSearch;
    lines.push(
      "",
      "Search output",
      `  ${"matches".padEnd(20)} ${integer(search.matches)}`,
      `  ${"files".padEnd(20)} ${integer(search.files)}`,
      `  ${"emitted lines".padEnd(20)} ${integer(search.emittedLines)}`,
      `  ${"context lines".padEnd(20)} ${integer(search.contextLines)}`,
    );
    if (search.omittedMatches !== undefined && search.omittedMatches > 0) {
      lines.push(`  ${"omitted matches".padEnd(20)} ${integer(search.omittedMatches)}`);
    }
    lines.push(
      `  ${"tool truncation".padEnd(20)} ${search.truncated === undefined ? "unknown" : search.truncated ? "yes" : "no"}`,
      `  ${"canonical admission".padEnd(20)} ${inspection.truncated ? "truncated" : "complete"}`,
      `  ${"inspect preview".padEnd(20)} ${resultPreview ? `${integer(resultPreview.shown)} / ${integer(resultPreview.total)} lines` : "-"}`,
    );
  }

  if (inspection.grepSearch?.truncated && inspection.grepSearch.maxLines !== undefined) {
    lines.push(
      "",
      "Output limit",
      `  ${"max lines".padEnd(20)} ${integer(inspection.grepSearch.maxLines)}`,
      `  ${"emitted lines".padEnd(20)} ${integer(inspection.grepSearch.emittedLines)}`,
    );
    if (
      inspection.grepSearch.omittedMatches !== undefined &&
      inspection.grepSearch.omittedMatches > 0
    ) {
      lines.push(
        `  ${"omitted matches".padEnd(20)} ${integer(inspection.grepSearch.omittedMatches)}`,
      );
    }
  }

  if (inspection.request) {
    lines.push("", "Request", indent(prettyArguments(inspection.request.content)));
  }
  if (inspection.result && resultPreview) {
    lines.push(
      "",
      "Result",
      `  ${integer(inspection.result.lines)} lines / ${bytes(inspection.result.bytes)} / ${inspection.result.tokens !== undefined ? `${inspection.result.tokenSource === "estimated" ? "~" : ""}${compactTokens(inspection.result.tokens)} tokens` : "tokens unavailable"}`,
      "",
      indent(resultPreview.text),
    );
    if (resultPreview.shown < resultPreview.total) {
      lines.push(
        `  [inspect preview, showing ${resultPreview.shown}/${resultPreview.total} lines; use --full or --payload]`,
      );
    }
    if (inspection.truncated) {
      lines.push(
        `  [canonical admission truncated the Tool result${inspection.truncationReason ? `: ${inspection.truncationReason}` : ""}; the displayed result is complete as persisted]`,
      );
    }
  }
  return lines.join("\n");
}
