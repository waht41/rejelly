import type {
  ModelCallInspection,
  ModelCallListInspection,
  ModelCallView,
} from "./modelCallInspection";

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function compact(value: number | undefined): string {
  if (value === undefined) return "-";
  if (Math.abs(value) < 1_000) return integer(value);
  return `${(value / 1_000).toFixed(value >= 100_000 ? 1 : 2)}k`;
}

function duration(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1_000) return `${integer(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function percentage(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function row(values: readonly string[], widths: readonly number[]): string {
  return values.map((value, index) => value.padStart(widths[index])).join("  ");
}

function modelIdentity(call: ModelCallInspection): string {
  return [call.model.modelId, call.model.provider, call.model.protocol].filter(Boolean).join(" · ");
}

function renderTable(
  calls: readonly ModelCallInspection[],
  view: ModelCallView,
  options: { includeTurn?: boolean } = {},
): string[] {
  const identities = new Set(calls.map(modelIdentity));
  const includeModel = identities.size > 1;
  const includeTurn = options.includeTurn ?? false;
  const prefixHeaders = ["#", ...(includeTurn ? ["turn"] : []), ...(includeModel ? ["model"] : [])];
  const prefixWidths = [
    5,
    ...(includeTurn ? [5] : []),
    ...(includeModel ? [Math.max(5, ...calls.map((call) => modelIdentity(call).length))] : []),
  ];
  const prefixValues = (call: ModelCallInspection): string[] => [
    call.address,
    ...(includeTurn ? [call.turnNumber ? `T${call.turnNumber}` : "-"] : []),
    ...(includeModel ? [modelIdentity(call)] : []),
  ];
  const definitions =
    view === "tokens"
      ? {
          headers: [...prefixHeaders, "input", "cache", "hit", "uncached", "output", "reasoning"],
          widths: [...prefixWidths, 8, 8, 7, 9, 8, 9],
          values: (call: ModelCallInspection) => [
            ...prefixValues(call),
            compact(call.usage?.promptTokens),
            compact(call.usage?.cacheReadTokens),
            percentage(call.cacheHitRate),
            compact(call.uncachedTokens),
            compact(call.usage?.completionTokens),
            compact(call.usage?.reasoningTokens),
          ],
        }
      : view === "latency"
        ? {
            headers: [...prefixHeaders, "TTFT", "generation", "total", "output tok/s"],
            widths: [...prefixWidths, 8, 11, 8, 12],
            values: (call: ModelCallInspection) => {
              const rate =
                call.generationMs && call.usage?.completionTokens !== undefined
                  ? ((call.usage.completionTokens * 1_000) / call.generationMs).toFixed(1)
                  : "-";
              return [
                ...prefixValues(call),
                duration(call.ttftMs),
                duration(call.generationMs),
                duration(call.durationMs),
                rate,
              ];
            },
          }
        : view === "transport"
          ? {
              headers: [
                ...prefixHeaders,
                "provider",
                "protocol",
                "attempts",
                "retry delay",
                "finish",
                "status",
              ],
              widths: [...prefixWidths, 10, 16, 8, 11, 12, 8],
              values: (call: ModelCallInspection) => [
                ...prefixValues(call),
                call.model.provider ?? "-",
                call.model.protocol ?? "-",
                String(call.attemptCount),
                duration(call.totalRetryDelayMs),
                call.finishReason ?? "-",
                call.status === "succeeded" ? "ok" : "failed",
              ],
            }
          : {
              headers: [
                ...prefixHeaders,
                "input",
                "cache",
                "uncached",
                "output",
                "reasoning",
                "TTFT",
                "duration",
                "status",
              ],
              widths: [...prefixWidths, 8, 8, 9, 8, 9, 8, 9, 8],
              values: (call: ModelCallInspection) => [
                ...prefixValues(call),
                compact(call.usage?.promptTokens),
                compact(call.usage?.cacheReadTokens),
                compact(call.uncachedTokens),
                compact(call.usage?.completionTokens),
                compact(call.usage?.reasoningTokens),
                duration(call.ttftMs),
                duration(call.durationMs),
                call.status === "succeeded" ? "ok" : "failed",
              ],
            };
  return [
    row(definitions.headers, definitions.widths),
    "-".repeat(
      definitions.widths.reduce((sum, width) => sum + width, 0) +
        (definitions.widths.length - 1) * 2,
    ),
    ...calls.map((call) => row(definitions.values(call), definitions.widths)),
  ];
}

export function renderModelCallList(
  inspection: ModelCallListInspection,
  options: { view?: ModelCallView } = {},
): string {
  const summary = inspection.summary;
  const title =
    inspection.scope === "turn"
      ? `Model calls — Turn ${inspection.turnId}`
      : inspection.scope === "range"
        ? `Model calls — ${inspection.selector}`
        : "Model calls";
  const lines = [title];
  if (inspection.scope === "session") {
    lines.push(
      `  calls                 ${integer(summary.calls)}`,
      `  successful            ${integer(summary.successful)}`,
      `  failed                ${integer(summary.failed)}`,
      `  retries               ${integer(summary.retries)}`,
      "",
      `  prompt                ${compact(summary.prompt.cumulativeTokens)} cumulative`,
      `  peak input            ${compact(summary.prompt.peakInputTokens)}`,
      `  amplification         ${summary.prompt.amplification.toFixed(1)}x`,
      "",
      `  completion            ${compact(summary.completionTokens)}`,
      `  reasoning             ${compact(summary.reasoningTokens)}`,
      "",
      `  cache read            ${compact(summary.cacheReadTokens)}`,
      `  cache write           ${compact(summary.cacheWriteTokens)}`,
      `  uncached              ${compact(summary.prompt.uncachedTokens)}`,
      `  weighted hit          ${percentage(summary.cacheHitRate)}`,
      "",
      `  duration              ${duration(summary.durationMs)}`,
      `  avg                   ${duration(summary.averageDurationMs)}`,
      `  p50 / p95             ${duration(summary.p50DurationMs)} / ${duration(summary.p95DurationMs)}`,
      `  TTFT p50 / p95        ${duration(summary.p50TtftMs)} / ${duration(summary.p95TtftMs)}`,
      "",
      "Notable calls",
    );
    if (inspection.notableCalls.length === 0) lines.push("  (none)");
    else {
      for (const notable of inspection.notableCalls) {
        const call = notable.call;
        const turn = call.turnNumber ? `T${call.turnNumber}` : "-";
        lines.push(
          `  ${call.address.padEnd(5)} ${turn.padEnd(5)} ${duration(call.durationMs).padStart(8)}  ${compact(call.uncachedTokens).padStart(8)} uncached  ${notable.reasons.join(", ")}`,
        );
      }
    }
    return lines.join("\n");
  }

  const calls = inspection.calls;
  if (calls.length === 0) return [...lines, "", "(none)"].join("\n");
  const identities = new Set(calls.map(modelIdentity));
  if (identities.size === 1) lines.push(`Model: ${modelIdentity(calls[0])}`);
  lines.push(
    "",
    ...renderTable(calls, options.view ?? "balanced", {
      includeTurn: inspection.scope === "range",
    }),
  );
  return lines.join("\n");
}

function detailLine(name: string, value: string): string {
  return `  ${name.padEnd(16)} ${value}`;
}

export function renderModelCallInspection(
  call: ModelCallInspection,
  options: { input?: boolean; attempts?: boolean } = {},
): string {
  const usage = call.usage;
  const lines = [
    `Model call ${call.address}`,
    `Turn: ${call.turnNumber ?? call.turnId ?? "(outside user turn)"}`,
    `Status: ${call.status}`,
    `Finish: ${call.finishReason ?? "-"}`,
    "",
    "Model",
    detailLine("model", call.model.modelId),
    detailLine("provider", call.model.provider ?? "-"),
    detailLine("protocol", call.model.protocol ?? "-"),
    detailLine("endpoint", call.model.endpoint ?? "-"),
    detailLine("adapter", call.model.adapterId),
    "",
    "Tokens",
    detailLine("prompt", usage ? integer(usage.promptTokens) : "-"),
    detailLine(
      "cache read",
      usage ? `${integer(usage.cacheReadTokens ?? 0)}   ${percentage(call.cacheHitRate)}` : "-",
    ),
    detailLine("cache write", usage ? integer(usage.cacheWriteTokens ?? 0) : "-"),
    detailLine("uncached", call.uncachedTokens === undefined ? "-" : integer(call.uncachedTokens)),
    detailLine("completion", usage ? integer(usage.completionTokens) : "-"),
    detailLine("reasoning", usage ? integer(usage.reasoningTokens ?? 0) : "-"),
    "",
    "Timing",
    detailLine("total", duration(call.durationMs)),
    detailLine("TTFT", duration(call.ttftMs)),
    detailLine("generation", duration(call.generationMs)),
    "",
    "Transport",
    detailLine("attempts", integer(call.attemptCount)),
    detailLine("retries", integer(call.retryCount)),
    detailLine("retry delay", duration(call.totalRetryDelayMs)),
  ];
  if (call.status === "failed") {
    lines.push("", "Error", detailLine("type", call.errorCode ?? "unknown"));
  }
  if (options.input) {
    lines.push("", "Input composition");
    if (!call.input) lines.push("  (not persisted for this call)");
    else {
      const input = call.input;
      lines.push(
        detailLine("message chars", integer(input.messageChars)),
        detailLine("system prompt", `${integer(input.systemPromptChars)} chars`),
        detailLine("tool results", `${integer(input.toolResultChars)} chars`),
        detailLine("tool schemas", `${integer(input.toolSchemaBytes)} bytes`),
        detailLine("tool definitions", integer(input.toolDefinitionCount)),
        detailLine(
          "messages by role",
          `system ${input.messagesByRole.system}, user ${input.messagesByRole.user}, assistant ${input.messagesByRole.assistant}, tool ${input.messagesByRole.tool}`,
        ),
      );
      if (input.toolDefinitions?.length) {
        lines.push("", "  Tool definitions");
        for (const tool of input.toolDefinitions)
          lines.push(`    ${tool.name.padEnd(28)} ${integer(tool.schemaBytes)} bytes`);
      }
    }
  }
  if (options.attempts) {
    lines.push("", "Attempts");
    if (call.attempts?.length) {
      for (const attempt of call.attempts) {
        const retryDelay =
          attempt.retryDelayMs === undefined ? "" : `   +${duration(attempt.retryDelayMs)} backoff`;
        const error = attempt.errorCode ? `   ${attempt.errorCode}` : "";
        lines.push(
          `  A${attempt.attempt}   ${attempt.status.padEnd(9)} ${duration(attempt.durationMs).padStart(8)}${error}${retryDelay}`,
        );
      }
    } else if (call.attemptCount === 1) {
      lines.push("  A1   logical call completed without a recorded retry");
    } else {
      lines.push(
        `  ${call.attemptCount} attempts recorded in aggregate; per-attempt details were not persisted by this older Session event.`,
      );
    }
  }
  return lines.join("\n");
}
