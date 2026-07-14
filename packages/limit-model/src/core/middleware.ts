import type { ConcurrencyRule, RateLimitRule, TokenRule } from "../rule";
import type { RateLimitStore } from "../store";
import { createProxyWrapper } from "../utils/proxy-wrapper";
import { defaultCalculatePreDeduct } from "./estimators";

/** Thrown when store.consume returns allowed: false. Carries retryAfterMs for HTTP Retry-After. */
export class RateLimitExceededError extends Error {
  readonly code = 429;
  /** Expected ms until client can retry; set from store ConsumeResult.retryAfterMs. */
  public retryAfterMs?: number;
  /** Which rule dimension blocked (e.g. "concurrency" or "token"). */
  public reason?: string;
  /** The rule that caused the limit to be exceeded. */
  public failedRule?: RateLimitRule;

  constructor(
    message = "Rate limit exceeded",
    retryAfterMs?: number,
    reason?: string,
    failedRule?: RateLimitRule,
  ) {
    super(message);
    this.name = "RateLimitExceededError";
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
    this.failedRule = failedRule;
  }
}

/**
 * Thrown when estimated tokens exceed a token rule's limit (request too large to ever succeed).
 * Not a rate limit (429); map to HTTP 413 Payload Too Large. Client must shorten input.
 */
export class TokenLimitExceededError extends Error {
  readonly code = 413;
  readonly estimatedTokens: number;
  readonly limit: number;

  constructor(estimatedTokens: number, limit: number) {
    super(
      `Payload Too Large: Estimated tokens (${estimatedTokens}) exceeds absolute bucket limit (${limit}). You must shorten your input.`,
    );
    this.name = "TokenLimitExceededError";
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
  }
}

/**
 * Minimal adapter shape for limit middleware (no dependency on core).
 * Compatible with ModelAdapter when used with @rejelly/core.
 */
export interface LimitAdapterLike {
  id: string;
  stream(
    messages: unknown[],
    options?: { signal?: AbortSignal; [k: string]: unknown },
  ): AsyncGenerator<
    { type: string; usage?: { totalTokens?: number }; [k: string]: unknown },
    void,
    unknown
  >;
}

/**
 * Middleware shape: same as ModelMiddleware in core (name + wrap + optional config).
 * Use withLimit() to create a middleware that wraps an adapter with rate limiting.
 */
export interface LimitMiddleware<Adapter extends LimitAdapterLike = LimitAdapterLike> {
  name: string;
  config?: Record<string, unknown>;
  wrap: (inner: Adapter) => Adapter;
}

/** Default buffer added to store's retryAfterMs so clients that retry exactly at that time don't hit limit again. */
export const DEFAULT_RETRY_AFTER_BUFFER_MS = 100;

export interface WithLimitOptions {
  /** Injected store; required. */
  store: RateLimitStore;
  /** Rate limit rules; each rule has its own key (e.g. tenant global concurrency + per-model RPM). */
  rules: RateLimitRule[];
  /** Pre-deduct token estimate from input messages before stream; refund with actual usage. Default: input text length / 4. */
  calculatePreDeduct?: (messages: unknown[]) => number;
  /** Buffer (ms) added to store's retryAfterMs before returning to client. Prefer over-reporting so strict retry clients don't hit limit again. Default: 100. */
  retryAfterBufferMs?: number;
}

/**
 * Create rate limit middleware (model middleware pattern).
 * Key is per-rule: e.g. rule { type: 'concurrency', key: 'tenant:A', limit: 10 } plus
 * { type: 'request', key: 'tenant:A:gpt4', limit: 50, windowMs: 60000 } so global concurrency and per-model RPM both apply.
 *
 * @param options - store, rules, optional calculatePreDeduct (default: input text length / 4)
 * @returns LimitMiddleware (use with augment(model, [withLimit(...)]) when used with core)
 */
export function withLimit<Adapter extends LimitAdapterLike>(
  options: WithLimitOptions,
): LimitMiddleware<Adapter> {
  const {
    store,
    rules,
    calculatePreDeduct = defaultCalculatePreDeduct,
    retryAfterBufferMs = DEFAULT_RETRY_AFTER_BUFFER_MS,
  } = options;

  const concurrencyRules = rules.filter((r): r is ConcurrencyRule => r.type === "concurrency");

  const tokenRules = rules.filter((r): r is TokenRule => r.type === "token");
  const hasTokenRule = tokenRules.length > 0;

  return {
    name: "limit",
    config: { rules },
    wrap(inner: Adapter): Adapter {
      const overrides = {
        stream: async function* (
          messages: unknown[],
          streamOptions?: { signal?: AbortSignal; [k: string]: unknown },
        ): AsyncGenerator<
          { type: string; usage?: { totalTokens?: number }; [k: string]: unknown },
          void,
          unknown
        > {
          const preDeduct = hasTokenRule ? calculatePreDeduct(messages) : 0;

          // Physical limit: estimated tokens > any token rule limit => request can never succeed (413, not 429)
          for (const tokenRule of tokenRules) {
            if (preDeduct > tokenRule.limit) {
              throw new TokenLimitExceededError(preDeduct, tokenRule.limit);
            }
          }

          const requestId = crypto.randomUUID();
          const result = await store.consume(rules, preDeduct, requestId);
          if (!result.allowed) {
            const message =
              result.reason != null
                ? `Rate limit exceeded for ${result.reason}`
                : "Rate limit exceeded";
            const retryAfterMs =
              result.retryAfterMs != null ? result.retryAfterMs + retryAfterBufferMs : undefined;
            throw new RateLimitExceededError(
              message,
              retryAfterMs,
              result.reason,
              result.failedRule,
            );
          }

          let totalTokens: number | undefined;
          let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

          try {
            if (result.lease) {
              heartbeatTimer = setInterval(() => {
                result.lease?.renew().catch((err) => {
                  console.warn(`[RateLimit] Failed to renew lease for ${requestId}:`, err);
                });
              }, result.lease.intervalMs);
            }

            for await (const event of inner.stream(messages, streamOptions)) {
              yield event;
              if (event.type === "usage" && event.usage?.totalTokens != null) {
                totalTokens = event.usage.totalTokens;
              }
            }

            if (hasTokenRule && totalTokens != null) {
              const adjustAmount = totalTokens - preDeduct;
              // adjustAmount = totalTokens - preDeduct: positive = overused (deduct more), negative = underused (add back)
              // actualValue = actualValue - actualCost = actualValue - (totalTokens-preDeduct) = actualValue - adjustAmount
              await Promise.all(tokenRules.map((rule) => store.adjust(rule, adjustAmount)));
            }
          } finally {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
            }
            await store.releaseConcurrency(concurrencyRules, requestId);
          }
        },
      };

      return createProxyWrapper(inner, overrides) as Adapter;
    },
  };
}
