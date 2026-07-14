import {
  isModelCallError,
  type Message,
  type ModelAdapter,
  type ModelMiddleware,
  type ModelStreamOptions,
  type StreamEvent,
} from "@rejelly/core";

export interface WithRetryOptions {
  /** Total attempts, including the first call. */
  maxAttempts?: number;
  /** Initial exponential backoff delay in ms. */
  initialDelayMs?: number;
  /** Backoff multiplier after each failed attempt. */
  backoffMultiplier?: number;
  /** Maximum delay between attempts in ms. */
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_DELAY_MS = 30_000;

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

function shouldRetry(error: unknown): boolean {
  if (isModelCallError(error)) {
    return error.code === "rate_limit" || error.code === "server_error";
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

export function withRetry(options: WithRetryOptions = {}): ModelMiddleware {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("withRetry: maxAttempts must be an integer >= 1");
  }
  if (initialDelayMs < 0 || backoffMultiplier < 1 || maxDelayMs < 0) {
    throw new Error("withRetry: invalid backoff options");
  }

  return {
    name: "evil_jelly_model_retry",
    config: { maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs },
    wrap(inner: ModelAdapter): ModelAdapter {
      return {
        ...inner,
        stream: async function* (
          messages: Message[],
          streamOptions?: ModelStreamOptions,
        ): AsyncGenerator<StreamEvent> {
          let nextBackoffMs = initialDelayMs;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let yielded = false;
            try {
              for await (const event of inner.stream(messages, streamOptions)) {
                yielded = true;
                yield event;
              }
              return;
            } catch (error) {
              const canRetry = !yielded && attempt < maxAttempts && shouldRetry(error);
              if (!canRetry) {
                throw error;
              }

              const retryAfterMs = readRetryAfterMs(error);
              const delayMs = clampDelay(retryAfterMs ?? nextBackoffMs, maxDelayMs);
              await sleep(delayMs, { signal: streamOptions?.signal });
              nextBackoffMs = clampDelay(nextBackoffMs * backoffMultiplier, maxDelayMs);
            }
          }
        },
      };
    },
  };
}
