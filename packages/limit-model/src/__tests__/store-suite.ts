/**
 * Shared test suite for any RateLimitStore implementation (Memory, Redis, etc.).
 * Interface-driven: one set of assertions, inject setup/cleanup/advanceTime per store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RateLimitRule, TokenRule } from "../rule.js";
import type { RateLimitStore } from "../store.js";

export interface TestSuiteOptions {
  /** Initialize store for each test */
  setupStore: () => Promise<RateLimitStore> | RateLimitStore;
  /** Cleanup after each test (e.g. Redis flushdb; Memory can call destroy) */
  cleanupStore: () => Promise<void> | void;
  /** Advance time: Memory uses fake timers, Redis uses real setTimeout */
  advanceTime: (ms: number) => Promise<void>;
  /** Base window for request/token rules; use smaller value (e.g. 150) for Redis to keep tests fast */
  baseWindowMs?: number;
}

export function defineStoreTestSuite(storeName: string, options: TestSuiteOptions): void {
  const { setupStore, cleanupStore, advanceTime, baseWindowMs = 60000 } = options;

  describe(`RateLimitStore Compliance: ${storeName}`, () => {
    let store: RateLimitStore;

    beforeEach(async () => {
      store = await Promise.resolve(setupStore());
    });

    afterEach(async () => {
      await Promise.resolve(cleanupStore());
    });

    it("1. Concurrency: over limit is rejected, release restores slot", async () => {
      const rule: RateLimitRule = { type: "concurrency", key: "test:conc", limit: 2 };

      const req1 = await store.consume([rule], 0, "req-1");
      const req2 = await store.consume([rule], 0, "req-2");
      expect(req1.allowed).toBe(true);
      expect(req2.allowed).toBe(true);

      const req3 = await store.consume([rule], 0, "req-3");
      expect(req3.allowed).toBe(false);
      expect(req3.reason).toBe("concurrency");

      await store.releaseConcurrency([rule], "req-1");
      const req4 = await store.consume([rule], 0, "req-4");
      expect(req4.allowed).toBe(true);
    });

    it("2. Request rate (RPM): after exhausted, window must elapse before recovery", async () => {
      const rule: RateLimitRule = {
        type: "request",
        key: "test:req",
        limit: 2,
        windowMs: baseWindowMs,
      };

      await store.consume([rule], 0, "r1");
      await store.consume([rule], 0, "r2");

      const r3 = await store.consume([rule], 0, "r3");
      expect(r3.allowed).toBe(false);
      expect(r3.retryAfterMs).toBeGreaterThan(0);

      await advanceTime(baseWindowMs);

      const r4 = await store.consume([rule], 0, "r4");
      expect(r4.allowed).toBe(true);
    });

    it("3. Token physical cap (413): preDeduct over rule limit must be rejected", async () => {
      const rule: RateLimitRule = {
        type: "token",
        key: "test:tpm",
        limit: 100,
        windowMs: baseWindowMs,
      };

      const r1 = await store.consume([rule], 150, "req-1");
      expect(r1.allowed).toBe(false);
      expect(r1.reason).toBe("token");
      expect(r1.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
    });

    it("4. Adjust: correctly refunds over-pre-deducted tokens", async () => {
      const rule: TokenRule = {
        type: "token",
        key: "test:tpm",
        limit: 100,
        windowMs: baseWindowMs,
      };

      await store.consume([rule], 90, "r1");
      await store.adjust(rule, -80);

      const r2 = await store.consume([rule], 80, "r2");
      expect(r2.allowed).toBe(true);
    });

    it("5. Race Condition: Promise.all high concurrency on Request limit (RPM)", async () => {
      const limit = 10;
      const rule: RateLimitRule = {
        type: "request",
        key: "test:race:req",
        limit: limit,
        windowMs: baseWindowMs,
      };

      const requests = Array.from({ length: 50 }, (_, i) => store.consume([rule], 0, `req-${i}`));
      const results = await Promise.all(requests);

      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(limit);
      expect(rejectedCount).toBe(50 - limit);
    });

    it("6. Race Condition: Promise.all high concurrency on Token limit (TPM oversell)", async () => {
      const totalTokens = 100;
      const deductPerRequest = 15;
      const rule: RateLimitRule = {
        type: "token",
        key: "test:race:tpm",
        limit: totalTokens,
        windowMs: baseWindowMs,
      };

      const requests = Array.from({ length: 20 }, (_, i) =>
        store.consume([rule], deductPerRequest, `req-${i}`),
      );
      const results = await Promise.all(requests);

      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;
      const expectedAllowed = Math.floor(totalTokens / deductPerRequest);

      expect(allowedCount).toBe(expectedAllowed);
      expect(rejectedCount).toBe(20 - expectedAllowed);
    });

    it("7. Race Condition: Promise.all high concurrency on Concurrency slot allocation", async () => {
      const limit = 5;
      const rule: RateLimitRule = {
        type: "concurrency",
        key: "test:race:conc",
        limit: limit,
      };

      const requests = Array.from({ length: 50 }, (_, i) => store.consume([rule], 0, `req-${i}`));
      const results = await Promise.all(requests);

      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(limit);
      expect(rejectedCount).toBe(50 - limit);

      const successfulRequestIds = results
        .map((r, i) => (r.allowed ? `req-${i}` : null))
        .filter((id): id is string => id !== null);

      const releases = successfulRequestIds.map((id) => store.releaseConcurrency([rule], id));
      await Promise.all(releases);

      const afterRelease = await store.consume([rule], 0, "req-after");
      expect(afterRelease.allowed).toBe(true);
    });
  });
}
