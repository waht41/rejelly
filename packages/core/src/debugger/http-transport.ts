/**
 * Shared HTTP transport for debugger exporters.
 *
 * Exporter core owns batching and backpressure. This module owns HTTP-specific
 * retry, status classification, and endpoint-level circuit breaking.
 */

import { toErrorInfo } from "../core/domain/errors";

export interface HttpSenderOptions {
  endpoint: string;
  headers: Record<string, string>;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryJitterMs?: number;
  circuitBreakerMs?: number;
}

const circuitBreakers = new Map<string, number>();

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const isDroppableClientError = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

// Node's fetch (undici) and browsers wrap the real failure in `error.cause`. Reuse the shared
// serializer and flatten to the errno code + message this module needs for logging/classification.
// The errno `code` is collected into `details` by toErrorInfo; for a wrapped `TypeError: fetch
// failed` it lives one level down in `cause`.
const errorDetail = (err: unknown): { code?: string; message: string } => {
  const info = toErrorInfo(err);
  const target = info.cause ?? info;
  const code = typeof target.details?.code === "string" ? target.details.code : undefined;
  return { code, message: target.message };
};

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const isNetworkError = (err: unknown): boolean => {
  if (err instanceof TypeError) return true;

  const { code, message } = errorDetail(err);
  if (code && NETWORK_ERROR_CODES.has(code)) return true;

  return (
    message.includes("fetch failed") ||
    message.includes("Failed to fetch") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT")
  );
};

// Human-readable cause for logs, e.g. "ECONNRESET (read ECONNRESET)".
const describeError = (err: unknown): string => {
  const { code, message } = errorDetail(err);
  if (code && !message.includes(code)) return `${code}: ${message}`;
  return code ?? message;
};

export function createHttpSender<T>(
  opts: HttpSenderOptions,
  serialize: (batch: T[]) => string,
): (batch: T[]) => Promise<void> {
  return async (batch: T[]) => {
    if (batch.length === 0) return;

    const brokenUntil = circuitBreakers.get(opts.endpoint) ?? 0;
    if (Date.now() < brokenUntil) {
      const remainingS = Math.ceil((brokenUntil - Date.now()) / 1000);
      console.warn(
        `[Transport] Circuit open for ${opts.endpoint} (${remainingS}s left), dropping ${batch.length} event(s).`,
      );
      return;
    }

    const maxRetries = opts.maxRetries ?? 3;
    const retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
    const retryJitterMs = opts.retryJitterMs ?? 500;
    const circuitBreakerMs = opts.circuitBreakerMs ?? 30000;
    const body = serialize(batch);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(opts.endpoint, {
          method: "POST",
          headers: opts.headers,
          body,
        });

        if (response.ok) {
          // Success acts as a half-open probe: clear any prior breaker for this endpoint.
          circuitBreakers.delete(opts.endpoint);
          return;
        }

        if (isDroppableClientError(response.status)) {
          const responseBody = await response.text().catch(() => "");
          console.error(
            `[Transport] Client error ${response.status} from ${opts.endpoint}, dropping ${batch.length} event(s).`,
            responseBody ? `\n  Response: ${responseBody}` : "",
          );
          return;
        }

        throw new Error(`HTTP_ERROR_${response.status}`);
      } catch (err) {
        const networkError = isNetworkError(err);
        const reason = describeError(err);

        if (attempt < maxRetries) {
          // Retry transient failures — including network errors. A spurious ECONNRESET on a
          // stale keep-alive socket clears on the next attempt, so we no longer trip the
          // circuit on a single blip.
          const delayMs =
            retryBaseDelayMs * 2 ** attempt +
            (retryJitterMs > 0 ? Math.random() * retryJitterMs : 0);
          console.warn(
            `[Transport] ${networkError ? "Network error" : "Send failed"} from ${opts.endpoint} ` +
              `(attempt ${attempt + 1}/${maxRetries + 1}: ${reason}), retrying in ${Math.round(delayMs)}ms.`,
          );
          await sleep(delayMs);
          continue;
        }

        // Retries exhausted. Only a sustained network failure opens the circuit; a persistent
        // server-side error just drops this batch without blinding the whole endpoint.
        if (networkError) {
          circuitBreakers.set(opts.endpoint, Date.now() + circuitBreakerMs);
          console.error(
            `[Transport] Unreachable ${opts.endpoint} after ${maxRetries + 1} attempts (${reason}). ` +
              `Circuit open for ${Math.round(circuitBreakerMs / 1000)}s, dropping ${batch.length} event(s).`,
          );
        } else {
          console.error(
            `[Transport] Max retries reached for ${opts.endpoint} (${reason}), dropping ${batch.length} event(s).`,
          );
        }
        return;
      }
    }
  };
}
