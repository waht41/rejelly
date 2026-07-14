/**
 * Concurrency Utilities
 *
 * Token bucket and semaphore for rate limiting and concurrency control.
 */

// ============ Token Bucket ============

/**
 * Token bucket for rate limiting
 *
 * Implements a token bucket algorithm with continuous refill.
 * Supports both pre-check (tryConsume) and post-payment (consume) patterns.
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

  /**
   * Try to consume tokens (for pre-check scenarios like RPM)
   * Only consumes if enough tokens are available
   */
  tryConsume(count: number): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Force consume tokens (for post-payment scenarios like TPM)
   * Allows tokens to go negative (debt), which will be repaid over time
   */
  consume(count: number): void {
    this.refill();
    this.tokens -= count;
  }

  /**
   * Get wait time needed before consuming count tokens
   * Works correctly even when tokens is negative (debt scenario)
   */
  getWaitTime(count: number): number {
    this.refill();
    if (this.tokens >= count) return 0;
    const needed = count - this.tokens;
    return Math.ceil(needed / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;
  }
}

// ============ Semaphore ============

/**
 * Waiter in the queue
 */
interface QueueWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timeoutId?: ReturnType<typeof setTimeout>;
  /** Flag to prevent race condition between timeout/abort and release */
  isSettled: boolean;
}

/**
 * Semaphore for concurrency control with AbortSignal and timeout support
 *
 * Race condition prevention:
 * The `isSettled` flag ensures that only one of timeout/abort/release can
 * successfully settle the waiter's promise. Without this, a race between
 * release() and timeout could cause "permit loss":
 *
 * 1. release() shifts waiter from queue
 * 2. Before resolve() executes, timeout fires and rejects
 * 3. release() calls resolve() but it has no effect (promise already settled)
 * 4. The permit is "given" to a waiter that actually rejected = permit lost!
 *
 * @example
 * ```typescript
 * const semaphore = new Semaphore(5) // 5 concurrent permits
 *
 * async function doWork() {
 *   await semaphore.acquire()
 *   try {
 *     // ... do work ...
 *   } finally {
 *     semaphore.release()
 *   }
 * }
 * ```
 */
export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private waitQueue: QueueWaiter[] = [];

  constructor(permits: number) {
    this.maxPermits = permits;
    this.permits = permits;
  }

  /**
   * Get current available permits
   */
  get available(): number {
    return this.permits;
  }

  /**
   * Get current queue length
   */
  get waiting(): number {
    return this.waitQueue.length;
  }

  /**
   * Acquire a permit
   *
   * @param signal - Optional abort signal
   * @param timeoutMs - Optional timeout in milliseconds
   * @throws {DOMException} If aborted
   * @throws {Error} If timeout
   */
  async acquire(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    // Check if already aborted
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // Need to wait in queue
    return new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, signal, isSettled: false };

      // Cleanup function to clear handlers (but NOT remove from queue - that's release's job)
      const clearHandlers = () => {
        if (waiter.timeoutId) {
          clearTimeout(waiter.timeoutId);
          waiter.timeoutId = undefined;
        }
        if (waiter.abortHandler && waiter.signal) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
          waiter.abortHandler = undefined;
        }
      };

      // Try to settle waiter with rejection (used by timeout and abort)
      // Returns true if this call won the race
      const tryReject = (error: Error): boolean => {
        if (waiter.isSettled) {
          return false; // Already settled by release() or another handler
        }
        waiter.isSettled = true;
        clearHandlers();
        // Remove from queue if still present
        const index = this.waitQueue.indexOf(waiter);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        reject(error);
        return true;
      };

      // Setup timeout
      if (timeoutMs && timeoutMs > 0) {
        waiter.timeoutId = setTimeout(() => {
          tryReject(new Error(`Concurrency queue timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      // Setup abort handler
      if (signal) {
        waiter.abortHandler = () => {
          tryReject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }

      this.waitQueue.push(waiter);
    });
  }

  /**
   * Release a permit
   *
   * If there are waiters in the queue, the permit is given to the next waiter.
   * Otherwise, the permit is returned to the pool.
   */
  release(): void {
    // Try to find the next waiter that we can successfully wake up
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;

      // Check if already settled (timeout or abort won the race)
      if (waiter.isSettled) {
        // This waiter was already rejected, try next one
        continue;
      }

      // Check if signal was aborted (but handler hasn't run yet)
      if (waiter.signal?.aborted) {
        // Mark as settled to prevent abort handler from running
        waiter.isSettled = true;
        // Clean up handlers
        if (waiter.timeoutId) {
          clearTimeout(waiter.timeoutId);
        }
        if (waiter.abortHandler && waiter.signal) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
        // CRITICAL: Must reject the promise! Otherwise it hangs forever.
        waiter.reject(new DOMException("Aborted", "AbortError"));
        // Continue to find a valid waiter to give the permit to
        continue;
      }

      // Win the race - mark as settled and resolve
      waiter.isSettled = true;

      // Clean up handlers
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
      if (waiter.abortHandler && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
      }

      // Successfully wake up this waiter
      waiter.resolve();
      return;
    }

    // No waiters, increment permits
    this.permits = Math.min(this.maxPermits, this.permits + 1);
  }

  /**
   * Run a function with automatic acquire/release
   *
   * Ensures the permit is released even if the function throws.
   *
   * @param fn - Function to run
   * @param signal - Optional abort signal
   * @param timeoutMs - Optional timeout for acquiring the permit
   */
  async run<T>(fn: () => T | Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    await this.acquire(signal, timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
