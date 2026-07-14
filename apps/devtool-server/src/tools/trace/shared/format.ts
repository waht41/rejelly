import type { TraceEvent } from "@rejelly/core";

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type TruncateStrategy = "middle" | "head" | "structure";

export function truncate(
  value: unknown,
  maxLength: number,
  strategy: TruncateStrategy = "middle",
): string {
  if (strategy === "structure" || (strategy === "middle" && isStructured(value))) {
    return truncateStructured(value, maxLength);
  }

  const text = stringify(value);
  if (text.length <= maxLength) return text;

  if (strategy === "head") {
    return `${text.slice(0, maxLength)}\n... [${text.length - maxLength} chars truncated]`;
  }

  const head = Math.floor(maxLength * 0.65);
  const tail = maxLength - head;
  return `${text.slice(0, head)}\n... [${text.length - maxLength} chars omitted] ...\n${text.slice(-tail)}`;
}

export function formatDuration(duration: number | null, fallback = "unknown"): string {
  return duration == null ? fallback : `${duration}ms`;
}

/** Collapse whitespace and clip to maxLength with a truncation marker. */
export function compactPreview(text: string, maxLength: number): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength)} ... [${compacted.length - maxLength} chars truncated]`;
}

const EVENT_SKIP_FIELDS = new Set(["type", "trace", "timestamp"]);

const HEAVY_FIELD_SUMMARIZERS: Record<string, (value: unknown) => string> = {
  messages: (value) =>
    Array.isArray(value)
      ? `(${value.length} messages; use list_message for details)`
      : truncate(value, 400),
  draft: (value) => `(keys: ${objectKeys(value)})`,
  memory: (value) => `(keys: ${objectKeys(value)})`,
  toolConfig: summarizeToolConfig,
  scopeLayers: (value) =>
    Array.isArray(value) ? `(${value.length} layers)` : truncate(value, 400),
  toolResults: summarizeToolResults,
};

const FIELD_BUDGETS: Record<string, number> = {
  error: 1200,
  errors: 1200,
};

const FIELD_STRATEGIES: Record<string, TruncateStrategy> = {
  aggregate: "structure",
  args: "structure",
  costs: "structure",
  delta: "structure",
  input: "structure",
  own: "structure",
  usage: "structure",
};

export function renderTraceEvent(event: TraceEvent, perField = 400, perEvent = 3000): string[] {
  const lines = [`${event.type} @ ${event.timestamp}`];
  let omitted = 0;

  for (const [key, value] of Object.entries(event)) {
    if (EVENT_SKIP_FIELDS.has(key) || value === undefined) continue;

    const rendered =
      HEAVY_FIELD_SUMMARIZERS[key]?.(value) ??
      truncate(value, FIELD_BUDGETS[key] ?? perField, FIELD_STRATEGIES[key] ?? "middle");
    const nextLine = `  ${key}: ${rendered}`;
    const nextLength = totalLength(lines) + nextLine.length + 1;

    if (nextLength > perEvent) {
      omitted += 1;
      continue;
    }

    lines.push(nextLine);
  }

  if (omitted > 0) {
    lines.push(`  ... ${omitted} fields omitted by event budget`);
  }

  return lines;
}

function objectKeys(value: unknown): string {
  const keys = Object.keys(asRecord(value));
  return keys.length > 0 ? keys.join(", ") : "none";
}

function summarizeToolConfig(value: unknown): string {
  const config = asRecord(value);
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const names = tools
    .map((tool) => asRecord(tool).name)
    .filter((name): name is string => typeof name === "string");
  const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
  return `(${tools.length} tools${suffix}; use list_agent_tool for details)`;
}

function summarizeToolResults(value: unknown): string {
  if (!Array.isArray(value)) return truncate(value, 400);
  const names = value
    .map((result) => asRecord(result).toolName)
    .filter((name): name is string => typeof name === "string");
  const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
  return `(${value.length} results${suffix}; see Tool results section)`;
}

function totalLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function isStructured(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateStructured(value: unknown, maxLength: number): string {
  const summarized = summarizeStructure(value);
  const text = stringify(summarized);
  if (text.length <= maxLength) return text;
  return truncate(text, maxLength, "head");
}

function summarizeStructure(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncate(value, 500, "middle");
  if (!isStructured(value)) return value;
  if (depth >= 3) return structureLabel(value);

  if (Array.isArray(value)) {
    const limit = 5;
    const items = value.slice(0, limit).map((item) => summarizeStructure(item, depth + 1));
    if (value.length > limit) {
      items.push(`... ${value.length - limit} more items omitted`);
    }
    return items;
  }

  const entries = Object.entries(value);
  const limit = 20;
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, limit)) {
    result[key] = summarizeStructure(item, depth + 1);
  }
  if (entries.length > limit) {
    result["..."] = `${entries.length - limit} more fields omitted`;
  }
  return result;
}

function structureLabel(value: object): string {
  if (Array.isArray(value)) return `[Array(${value.length})]`;
  const keys = Object.keys(value);
  return `{Object${keys.length > 0 ? ` keys=${keys.slice(0, 8).join(",")}` : ""}}`;
}
