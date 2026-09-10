import {
  isModelCallError,
  type Message,
  type ModelAdapter,
  type ModelMiddleware,
  type ModelStreamOptions,
  type StreamEvent,
} from "@rejelly/core";
import {
  type ModelAttemptMetrics,
  recordModelRetryMetrics,
} from "../../shared/model/observation/modelRetryMetrics";

export type ConnectionRetryMode = "bounded" | "unbounded";

export interface ModelRetryNotice {
  kind: "connection" | "transient";
  retryCount: number;
  maxRetries?: number;
  delayMs: number;
  error: unknown;
}

/** Retry policy applied by Evil Jelly's model composition boundary. */
export interface WithRetryOptions {
  /** Total transient attempts, including the first call. */
  maxAttempts?: number;
  /** Initial transient-error exponential backoff delay in ms. */
  initialDelayMs?: number;
  /** Backoff multiplier after each failed attempt. */
  backoffMultiplier?: number;
  /** Maximum delay between transient attempts in ms. */
  maxDelayMs?: number;
  /** Random delay added as a fraction of the selected backoff. */
  jitterRatio?: number;
  /** Whether connection failures have the bounded transient budget or wait until cancellation. */
  connectionRetry?: ConnectionRetryMode;
  /** Initial wait after a connection failure in ms. */
  connectionInitialDelayMs?: number;
  /** Maximum wait between connection attempts in ms. */
  connectionMaxDelayMs?: number;
  /** Best-effort retry observation for host status presentation. */
  onRetry?: (notice: ModelRetryNotice) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.25;
const DEFAULT_CONNECTION_INITIAL_DELAY_MS = 5_000;
const DEFAULT_CONNECTION_MAX_DELAY_MS = 60_000;

function sleep(delayMs: number, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason ?? new Error("Aborted"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(options.signal?.reason ?? new Error("Aborted"));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorCode(error: unknown): string {
  if (isModelCallError(error)) return error.code;
  if (isLocalRateLimitError(error)) return "rate_limit";
  return error instanceof Error ? error.name : "unknown";
}

function isConnectionError(error: unknown): boolean {
  return isModelCallError(error) && error.code === "connection_error";
}

function shouldRetryTransient(error: unknown): boolean {
  if (isModelCallError(error)) {
    return error.code === "rate_limit" || error.code === "server_error" || error.code === "timeout";
  }
  return isLocalRateLimitError(error);
}

function isLocalRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  return record.name === "RateLimitExceededError" || record.code === 429;
}

function readRetryAfterMs(error: unknown): number | undefined {
  const retryAfterMs = readNumericProperty(error, "retryAfterMs");
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  if (!isModelCallError(error)) {
    return undefined;
  }

  const cause = error.cause;
  const headers = readObjectProperty(cause, "headers");
  const retryAfter = readHeader(headers, "retry-after");
  if (retryAfter === undefined) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryAt = Date.parse(retryAfter);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

function readNumericProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function readObjectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const record = headers as Record<string, unknown>;
  const matchedKey = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
  const raw = matchedKey !== undefined ? record[matchedKey] : undefined;
  return typeof raw === "string" ? raw : undefined;
}

function clampDelay(delayMs: number, maxDelayMs: number): number {
  return Math.max(0, Math.min(delayMs, maxDelayMs));
}

/** Add positive jitter so concurrent clients never retry earlier than the selected delay. */
export function addRetryJitter(
  delayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  return clampDelay(delayMs + delayMs * jitterRatio * random(), maxDelayMs);
}

export function withRetry(options: WithRetryOptions = {}): ModelMiddleware {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const connectionRetry = options.connectionRetry ?? "bounded";
  const connectionInitialDelayMs =
    options.connectionInitialDelayMs ?? DEFAULT_CONNECTION_INITIAL_DELAY_MS;
  const connectionMaxDelayMs = options.connectionMaxDelayMs ?? DEFAULT_CONNECTION_MAX_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("withRetry: maxAttempts must be an integer >= 1");
  }
  if (
    initialDelayMs < 0 ||
    backoffMultiplier < 1 ||
    maxDelayMs < 0 ||
    jitterRatio < 0 ||
    jitterRatio > 1 ||
    connectionInitialDelayMs < 0 ||
    connectionMaxDelayMs < 0
  ) {
    throw new Error("withRetry: invalid backoff options");
  }

  return {
    name: "evil_jelly_model_retry",
    config: {
      maxAttempts,
      initialDelayMs,
      backoffMultiplier,
      maxDelayMs,
      jitterRatio,
      connectionRetry,
      connectionInitialDelayMs,
      connectionMaxDelayMs,
    },
    wrap(inner: ModelAdapter): ModelAdapter {
      return {
        ...inner,
        stream: async function* (
          messages: Message[],
          streamOptions?: ModelStreamOptions,
        ): AsyncGenerator<StreamEvent> {
          let physicalAttempt = 0;
          let transientRetries = 0;
          let connectionRetries = 0;
          let nextBackoffMs = initialDelayMs;
          let nextConnectionBackoffMs = connectionInitialDelayMs;
          let totalRetryDelayMs = 0;
          const attempts: ModelAttemptMetrics[] = [];
          const publishMetrics = (): void =>
            recordModelRetryMetrics({ attempts: [...attempts], totalRetryDelayMs });

          while (true) {
            physicalAttempt += 1;
            let yielded = false;
            const attemptStartedAt = Date.now();
            try {
              for await (const event of inner.stream(messages, streamOptions)) {
                yielded = true;
                yield event;
              }
              attempts.push({
                attempt: physicalAttempt,
                status: "succeeded",
                durationMs: Date.now() - attemptStartedAt,
              });
              publishMetrics();
              return;
            } catch (error) {
              const failedAttempt: ModelAttemptMetrics = {
                attempt: physicalAttempt,
                status: "failed",
                durationMs: Date.now() - attemptStartedAt,
                errorCode: errorCode(error),
              };
              attempts.push(failedAttempt);

              const connectionFailure = isConnectionError(error);
              const canRetryConnection =
                !yielded &&
                connectionFailure &&
                (connectionRetry === "unbounded" || connectionRetries < maxAttempts - 1);
              const canRetryTransient =
                !yielded &&
                !connectionFailure &&
                transientRetries < maxAttempts - 1 &&
                shouldRetryTransient(error);
              if (!canRetryConnection && !canRetryTransient) {
                publishMetrics();
                throw error;
              }

              let delayMs: number;
              let notice: ModelRetryNotice;
              if (canRetryConnection) {
                connectionRetries += 1;
                delayMs = addRetryJitter(
                  nextConnectionBackoffMs,
                  connectionMaxDelayMs,
                  jitterRatio,
                );
                nextConnectionBackoffMs = clampDelay(
                  nextConnectionBackoffMs * backoffMultiplier,
                  connectionMaxDelayMs,
                );
                notice = {
                  kind: "connection",
                  retryCount: connectionRetries,
                  ...(connectionRetry === "bounded" ? { maxRetries: maxAttempts - 1 } : {}),
                  delayMs,
                  error,
                };
              } else {
                transientRetries += 1;
                const retryAfterMs = readRetryAfterMs(error);
                delayMs = addRetryJitter(retryAfterMs ?? nextBackoffMs, maxDelayMs, jitterRatio);
                nextBackoffMs = clampDelay(nextBackoffMs * backoffMultiplier, maxDelayMs);
                notice = {
                  kind: "transient",
                  retryCount: transientRetries,
                  maxRetries: maxAttempts - 1,
                  delayMs,
                  error,
                };
              }

              try {
                options.onRetry?.(notice);
              } catch {
                // Host presentation is best-effort and must not change model retry behavior.
              }

              const delayStartedAt = Date.now();
              try {
                await sleep(delayMs, { signal: streamOptions?.signal });
              } finally {
                failedAttempt.retryDelayMs = Date.now() - delayStartedAt;
                totalRetryDelayMs += failedAttempt.retryDelayMs;
                publishMetrics();
              }
            }
          }
        },
      };
    },
  };
}
