/**
 * Multi-rule short-circuit order and failedRule attribution suite.
 * Ensures the system blocks strictly in rule array order and that ConsumeResult/Error
 * carry the exact rule that caused the failure.
 * Store is injected via setupStore/cleanupStore (same contract as store-suite).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateLimitExceededError, withLimit } from "../core/middleware.js";
import type { RateLimitRule } from "../rule.js";
import type { RateLimitStore } from "../store.js";
import type { TestSuiteOptions } from "./store-suite.js";

export function defineMultiRuleAndFailedRuleSuite(
  storeName: string,
  options: TestSuiteOptions,
): void {
  const { setupStore, cleanupStore, baseWindowMs = 60000 } = options;

  describe(`Multi-rule short-circuit and failedRule: ${storeName}`, () => {
    let store: RateLimitStore;

    beforeEach(async () => {
      store = await Promise.resolve(setupStore());
    });

    afterEach(async () => {
      await Promise.resolve(cleanupStore());
    });

    describe("multi-rule order: strict array order, no over-check", () => {
      it("fails on first rule when [Request, Concurrency] and both would be violated", async () => {
        const requestRule: RateLimitRule = {
          type: "request",
          key: "test:order:req",
          limit: 1,
          windowMs: baseWindowMs,
        };
        const concurrencyRule: RateLimitRule = {
          type: "concurrency",
          key: "test:order:conc",
          limit: 1,
        };
        const rules: RateLimitRule[] = [requestRule, concurrencyRule];

        await store.consume(rules, 0, "req-1");
        const r2 = await store.consume(rules, 0, "req-2");
        expect(r2.allowed).toBe(false);
        expect(r2.reason).toBe("request");
        expect(r2.failedRule).toEqual(requestRule);
      });

      it("fails on first rule when [Concurrency, Request] and both would be violated", async () => {
        const concurrencyRule: RateLimitRule = {
          type: "concurrency",
          key: "test:order2:conc",
          limit: 1,
        };
        const requestRule: RateLimitRule = {
          type: "request",
          key: "test:order2:req",
          limit: 1,
          windowMs: baseWindowMs,
        };
        const rules: RateLimitRule[] = [concurrencyRule, requestRule];

        await store.consume(rules, 0, "req-1");
        const r2 = await store.consume(rules, 0, "req-2");
        expect(r2.allowed).toBe(false);
        expect(r2.reason).toBe("concurrency");
        expect(r2.failedRule).toEqual(concurrencyRule);
      });
    });

    describe("failedRule attribution on ConsumeResult", () => {
      it("ConsumeResult.failedRule is the exact rule that caused rejection (concurrency)", async () => {
        const rule: RateLimitRule = { type: "concurrency", key: "test:attr:conc", limit: 1 };
        await store.consume([rule], 0, "req-1");
        const r = await store.consume([rule], 0, "req-2");
        expect(r.allowed).toBe(false);
        expect(r.failedRule).toBeDefined();
        expect(r.failedRule).toEqual(rule);
        expect(r.failedRule?.key).toBe("test:attr:conc");
        expect(r.failedRule?.type).toBe("concurrency");
      });

      it("ConsumeResult.failedRule is the exact rule that caused rejection (request)", async () => {
        const rule: RateLimitRule = {
          type: "request",
          key: "test:attr:req",
          limit: 1,
          windowMs: baseWindowMs,
        };
        await store.consume([rule], 0, "req-1");
        const r = await store.consume([rule], 0, "req-2");
        expect(r.allowed).toBe(false);
        expect(r.failedRule).toEqual(rule);
        expect(r.failedRule?.key).toBe("test:attr:req");
      });

      it("ConsumeResult.failedRule is the exact rule that caused rejection (token)", async () => {
        const rule: RateLimitRule = {
          type: "token",
          key: "test:attr:token",
          limit: 10,
          windowMs: baseWindowMs,
        };
        const r = await store.consume([rule], 20, "req-1");
        expect(r.allowed).toBe(false);
        expect(r.failedRule).toEqual(rule);
        expect(r.failedRule?.key).toBe("test:attr:token");
      });
    });

    describe("failedRule on RateLimitExceededError from middleware", () => {
      it("withLimit throws RateLimitExceededError with reason and failedRule", async () => {
        const concurrencyRule: RateLimitRule = {
          type: "concurrency",
          key: "test:middleware:conc",
          limit: 1,
        };
        const fakeAdapter = {
          id: "fake",
          async *stream() {
            yield { type: "usage", usage: {} };
          },
        };
        const mw = withLimit({ store, rules: [concurrencyRule] });
        const wrapped = mw.wrap(fakeAdapter);

        const it1 = wrapped.stream([]);
        await it1.next();

        await expect(wrapped.stream([]).next()).rejects.toMatchObject({
          name: "RateLimitExceededError",
          code: 429,
          reason: "concurrency",
          failedRule: concurrencyRule,
        });
        try {
          await wrapped.stream([]).next();
        } catch (err) {
          expect(err).toBeInstanceOf(RateLimitExceededError);
          expect((err as RateLimitExceededError).failedRule?.key).toBe("test:middleware:conc");
        }
      });
    });
  });
}
