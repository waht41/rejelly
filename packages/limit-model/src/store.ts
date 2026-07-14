import type { ConcurrencyRule, RateLimitRule, TokenRule } from "./rule";

/**
 * Result of consume: allowed or blocked with Retry-After hint.
 * Store (e.g. Redis Lua) should return retryAfterMs when rejecting:
 * - token/request: PTTL of the bucket window (exact).
 * - concurrency: estimated or fixed backoff (e.g. 5000 ms).
 */
export interface ConsumeResult {
  allowed: boolean;
  /** Expected ms until client can retry; for HTTP 429 Retry-After. */
  retryAfterMs?: number;
  /** Which rule dimension blocked (when allowed is false). */
  reason?: "concurrency" | "token" | "request";
  /** The rule that caused the limit to be exceeded (when allowed is false). */
  failedRule?: RateLimitRule;

  /**
   * Lease when the store needs to keep concurrency state alive (e.g. Redis).
   * Middleware should call renew() every intervalMs while the stream is alive.
   */
  lease?: {
    renew: () => Promise<void>;
    intervalMs: number;
  };
}

/**
 * Standard contract for all backing stores (e.g. MemoryStore, RedisStore).
 * Each rule carries its own key so one request can be limited by multiple keys (e.g. tenant global + per-model).
 */
export interface RateLimitStore {
  /**
   * Batch atomic check and pre-deduct for all rules (each rule has its own key).
   * When rejecting, return retryAfterMs so caller can set Retry-After (e.g. from Redis PTTL for token/request).
   * @param rules Applicable rate limit rules (each rule.key is the store key for that dimension)
   * @param preDeductTokens Pre-deduct token amount (only when a token rule exists)
   * @param requestId Unique request ID for concurrency tracking and release
   * @returns ConsumeResult (allowed + optional retryAfterMs and reason when blocked)
   */
  consume(
    rules: RateLimitRule[],
    preDeductTokens: number,
    requestId: string,
  ): Promise<ConsumeResult>;

  /**
   * Adjust token balance after stream (settle): positive = deduct more, negative = add back.
   * @param rule The token rule (carries key)
   * @param adjustAmount totalTokens - preDeduct: positive = overused, negative = underused
   */
  adjust(rule: TokenRule, adjustAmount: number): Promise<void>;

  /**
   * Release concurrency semaphore for all concurrency rules that were consumed.
   * @param rules ConcurrencyRules that were passed to consume for this request
   * @param requestId Unique request ID passed to consume
   */
  releaseConcurrency(rules: ConcurrencyRule[], requestId: string): Promise<void>;
}
