import type { ConcurrencyRule, RateLimitRule, RequestRule, TokenRule } from "../../rule";
import type { ConsumeResult, RateLimitStore } from "../../store";
import { TokenBucket } from "../../utils/concurrency";

function bucketRefillRatePerMinute(limit: number, windowMs: number): number {
  return (limit * 60000) / windowMs;
}

const GC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * In-memory implementation of RateLimitStore using TokenBucket (request/token) and counters (concurrency).
 * Suitable for single-process or testing; for multi-process use Redis (or similar) store.
 * Runs a periodic GC to remove idle buckets so keys do not grow unbounded.
 */
export class MemoryStore implements RateLimitStore {
  private readonly concurrency = new Map<string, { used: number; limit: number }>();
  private readonly requestBuckets = new Map<string, TokenBucket>();
  private readonly tokenBuckets = new Map<string, TokenBucket>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    this.gcTimer.unref();
  }

  /** Stops the GC timer; call when the store is no longer needed (e.g. in tests). */
  destroy(): void {
    clearInterval(this.gcTimer);
  }

  private getOrCreateConcurrency(key: string, limit: number): { used: number; limit: number } {
    let state = this.concurrency.get(key);
    if (!state) {
      state = { used: 0, limit };
      this.concurrency.set(key, state);
    }
    return state;
  }

  private getOrCreateRequestBucket(rule: RequestRule): TokenBucket {
    let bucket = this.requestBuckets.get(rule.key);
    if (!bucket) {
      const refillPerMin = bucketRefillRatePerMinute(rule.limit, rule.windowMs);
      bucket = new TokenBucket(rule.limit, refillPerMin);
      this.requestBuckets.set(rule.key, bucket);
    }
    return bucket;
  }

  private getOrCreateTokenBucket(rule: TokenRule): TokenBucket {
    let bucket = this.tokenBuckets.get(rule.key);
    if (!bucket) {
      const refillPerMin = bucketRefillRatePerMinute(rule.limit, rule.windowMs);
      bucket = new TokenBucket(rule.limit, refillPerMin);
      this.tokenBuckets.set(rule.key, bucket);
    }
    return bucket;
  }

  async consume(
    rules: RateLimitRule[],
    preDeductTokens: number,
    _requestId: string,
  ): Promise<ConsumeResult> {
    // Phase 1: validate in rule order (same as Redis Lua)
    for (const rule of rules) {
      if (rule.type === "token") {
        if (preDeductTokens > rule.limit) {
          return {
            allowed: false,
            reason: "token",
            retryAfterMs: Number.POSITIVE_INFINITY,
            failedRule: rule,
          };
        }
        const bucket = this.getOrCreateTokenBucket(rule);
        const waitMs = bucket.getWaitTime(preDeductTokens);
        if (waitMs > 0) {
          return { allowed: false, reason: "token", retryAfterMs: waitMs, failedRule: rule };
        }
      } else if (rule.type === "request") {
        const bucket = this.getOrCreateRequestBucket(rule);
        const waitMs = bucket.getWaitTime(1);
        if (waitMs > 0) {
          return { allowed: false, reason: "request", retryAfterMs: waitMs, failedRule: rule };
        }
      } else if (rule.type === "concurrency") {
        const state = this.getOrCreateConcurrency(rule.key, rule.limit);
        if (state.used >= state.limit) {
          return { allowed: false, reason: "concurrency", failedRule: rule };
        }
      }
    }

    // Phase 2: commit in same order
    for (const rule of rules) {
      if (rule.type === "token") {
        const bucket = this.getOrCreateTokenBucket(rule);
        bucket.consume(preDeductTokens);
      } else if (rule.type === "request") {
        const bucket = this.getOrCreateRequestBucket(rule);
        bucket.consume(1);
      } else if (rule.type === "concurrency") {
        const state = this.getOrCreateConcurrency(rule.key, rule.limit);
        state.used += 1;
      }
    }

    return { allowed: true };
  }

  async adjust(rule: TokenRule, adjustAmount: number): Promise<void> {
    const bucket = this.tokenBuckets.get(rule.key);
    if (!bucket) return;
    bucket.consume(adjustAmount);
  }

  async releaseConcurrency(rules: ConcurrencyRule[], _requestId: string): Promise<void> {
    for (const rule of rules) {
      const state = this.concurrency.get(rule.key);
      if (state && state.used > 0) {
        state.used -= 1;
      }
    }
  }

  private gc(): void {
    for (const [key, bucket] of this.tokenBuckets.entries()) {
      if (bucket.isFull()) this.tokenBuckets.delete(key);
    }
    for (const [key, bucket] of this.requestBuckets.entries()) {
      if (bucket.isFull()) this.requestBuckets.delete(key);
    }
    for (const [key, state] of this.concurrency.entries()) {
      if (state.used === 0) this.concurrency.delete(key);
    }
  }
}
