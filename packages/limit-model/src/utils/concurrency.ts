/**
 * Token bucket for rate limiting (in-memory).
 * Copied from @rejelly/core utils/concurrency for use in MemoryStore.
 * Continuous refill; supports tryConsume (pre-check) and consume (post-payment, can go negative).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxTokens: number, refillRatePerMinute: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = refillRatePerMinute / 60000;
  }

  tryConsume(count: number): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  consume(count: number): void {
    this.refill();
    this.tokens -= count;
  }

  getWaitTime(count: number): number {
    this.refill();
    if (this.tokens >= count) return 0;
    const needed = count - this.tokens;
    return Math.ceil(needed / this.refillRate);
  }

  /** True when bucket has refilled to max (idle); used by MemoryStore GC. */
  isFull(): boolean {
    this.refill();
    return this.tokens >= this.maxTokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;
  }
}
