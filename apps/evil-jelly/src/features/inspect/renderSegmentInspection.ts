import type { SegmentInspection } from "./segmentInspection";

const PREVIEW_LINES = 40;

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

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

export function renderSegmentInspection(
  inspection: SegmentInspection,
  options: { full?: boolean } = {},
): string {
  const estimated = inspection.tokenSource === "estimated" ? "~" : "";
  const lines = [
    `Segment #${inspection.address}`,
    `Turn: ${inspection.turnId}`,
    `Kind: ${inspection.kind}`,
    `Label: ${inspection.label}`,
    `Tokens: ${estimated}${compactTokens(inspection.tokens)}`,
    `Context: ${integer(inspection.contextBefore)} -> ${integer(inspection.contextAfter)}`,
  ];

  if (!inspection.payload) {
    lines.push(
      "",
      "Content",
      `  [unavailable: ${inspection.unavailableReason ?? "not persisted"}]`,
    );
    return lines.join("\n");
  }

  const serialized = JSON.stringify(inspection.payload.value, null, 2);
  const payloadLines = serialized.length === 0 ? [] : serialized.split(/\r?\n/);
  const shown = options.full ? payloadLines.length : Math.min(payloadLines.length, PREVIEW_LINES);
  lines.push(
    "",
    `Content (${inspection.payload.kind})`,
    "",
    indent(payloadLines.slice(0, shown).join("\n")),
  );
  if (shown < payloadLines.length) {
    lines.push(
      `  [truncated preview, showing ${shown}/${payloadLines.length} lines; use --full or --dump]`,
    );
  }
  return lines.join("\n");
}
