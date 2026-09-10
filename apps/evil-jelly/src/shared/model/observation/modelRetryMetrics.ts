import { equipTraceAttr, isContextNotFoundError } from "@rejelly/core";

export const MODEL_RETRY_METRICS_TRACE_ATTRIBUTE = "evil_jelly.model_retry";

export interface ModelAttemptMetrics {
  attempt: number;
  status: "succeeded" | "failed";
  durationMs: number;
  errorCode?: string;
  retryDelayMs?: number;
}

export interface ModelRetryMetrics {
  attempts: ModelAttemptMetrics[];
  totalRetryDelayMs: number;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readModelRetryMetrics(
  attributes: Readonly<Record<string, unknown>> | undefined,
): ModelRetryMetrics | undefined {
  const value = attributes?.[MODEL_RETRY_METRICS_TRACE_ATTRIBUTE];
  if (typeof value !== "object" || value === null) return undefined;
  const metrics = value as Partial<ModelRetryMetrics>;
  if (
    !Array.isArray(metrics.attempts) ||
    !nonNegative(metrics.totalRetryDelayMs) ||
    metrics.attempts.some(
      (attempt) =>
        typeof attempt !== "object" ||
        attempt === null ||
        !Number.isInteger(attempt.attempt) ||
        attempt.attempt < 1 ||
        (attempt.status !== "succeeded" && attempt.status !== "failed") ||
        !nonNegative(attempt.durationMs) ||
        (attempt.errorCode !== undefined && typeof attempt.errorCode !== "string") ||
        (attempt.retryDelayMs !== undefined && !nonNegative(attempt.retryDelayMs)),
    )
  ) {
    return undefined;
  }
  return metrics as ModelRetryMetrics;
}

export function recordModelRetryMetrics(metrics: ModelRetryMetrics): void {
  try {
    equipTraceAttr({ [MODEL_RETRY_METRICS_TRACE_ATTRIBUTE]: metrics }, { target: "local" });
  } catch (error) {
    if (!isContextNotFoundError(error)) throw error;
  }
}
