export interface ToolExecutionSummaryEntry {
  callCount: number;
  successCount: number;
  failureCount: number;
  totalOutputChars: number;
  cacheCount: number;
}

export type ToolExecutionSummary = Record<string, ToolExecutionSummaryEntry>;

type ToolExecutionResultLike = {
  toolName?: unknown;
  success?: unknown;
  cache?: unknown;
  output?: unknown;
};

type ToolsExecuteEndLike = {
  toolNames?: unknown;
  toolResults?: unknown;
  success?: unknown;
};

function emptyEntry(): ToolExecutionSummaryEntry {
  return {
    callCount: 0,
    successCount: 0,
    failureCount: 0,
    totalOutputChars: 0,
    cacheCount: 0,
  };
}

function getEntry(summary: ToolExecutionSummary, toolName: string): ToolExecutionSummaryEntry {
  summary[toolName] ??= emptyEntry();
  return summary[toolName];
}

function readToolName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mergeOne(
  summary: ToolExecutionSummary,
  toolName: string,
  options: {
    success: boolean;
    outputChars?: number;
    cache?: boolean;
  },
): void {
  const entry = getEntry(summary, toolName);
  entry.callCount += 1;
  if (options.success) {
    entry.successCount += 1;
  } else {
    entry.failureCount += 1;
  }
  if (options.outputChars !== undefined && Number.isFinite(options.outputChars)) {
    entry.totalOutputChars += options.outputChars;
  }
  if (options.cache) {
    entry.cacheCount += 1;
  }
}

function countOutputChars(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output === undefined) return 0;
  try {
    return JSON.stringify(output)?.length ?? 0;
  } catch {
    return String(output).length;
  }
}

export function parseToolExecutionSummaryJson(
  raw: string | null | undefined,
): ToolExecutionSummary {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as ToolExecutionSummary;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function collectToolExecutionSummary(event: ToolsExecuteEndLike): ToolExecutionSummary {
  const summary: ToolExecutionSummary = {};

  if (Array.isArray(event.toolResults) && event.toolResults.length > 0) {
    for (const rawResult of event.toolResults) {
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
        continue;
      }
      const result = rawResult as ToolExecutionResultLike;
      const toolName = readToolName(result.toolName);
      if (!toolName) continue;

      mergeOne(summary, toolName, {
        success: result.success === true,
        outputChars: countOutputChars(result.output),
        cache: result.cache === true,
      });
    }
    return summary;
  }

  if (Array.isArray(event.toolNames)) {
    for (const rawName of event.toolNames) {
      const toolName = readToolName(rawName);
      if (!toolName) continue;
      mergeOne(summary, toolName, {
        success: event.success === true,
      });
    }
  }

  return summary;
}

export function mergeToolExecutionSummary(
  target: ToolExecutionSummary,
  delta: ToolExecutionSummary,
): ToolExecutionSummary {
  for (const [toolName, entry] of Object.entries(delta)) {
    const current = getEntry(target, toolName);
    current.callCount += entry.callCount;
    current.successCount += entry.successCount;
    current.failureCount += entry.failureCount;
    current.totalOutputChars += entry.totalOutputChars ?? 0;
    current.cacheCount += entry.cacheCount;
  }
  return target;
}
