/**
 * Model-level test suite: uses createMockModel + augmentModel(withLimit) to verify
 * rate limiting and failedRule at the model adapter layer (same as production usage).
 * Store is injected via setupStore/cleanupStore (same contract as store-suite).
 */

import { augmentModel } from "@rejelly/core";
import { createMockModel } from "@rejelly/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateLimitExceededError, withLimit } from "../core/middleware.js";
import type { RateLimitRule } from "../rule.js";
import type { RateLimitStore } from "../store.js";
import type { TestSuiteOptions } from "./store-suite.js";

export function defineModelTestSuite(storeName: string, options: TestSuiteOptions): void {
  const { setupStore, cleanupStore, baseWindowMs = 60000 } = options;

  describe(`Model (mock + augment): ${storeName}`, () => {
    let store: RateLimitStore;

    beforeEach(async () => {
      store = await Promise.resolve(setupStore());
    });

    afterEach(async () => {
      await Promise.resolve(cleanupStore());
    });

    it("augmentModel(mock, [withLimit]) enforces concurrency and throws RateLimitExceededError with failedRule", async () => {
      const concurrencyRule: RateLimitRule = {
        type: "concurrency",
        key: "model-test:conc",
        limit: 1,
      };
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      mock.setDefaultUsage({ totalTokens: 1 });

      const limitedModel = augmentModel(mock.adapter, [
        withLimit({ store, rules: [concurrencyRule] }),
      ] as Parameters<typeof augmentModel>[1]);

      const it1 = limitedModel.stream([{ role: "user", content: "a" }]);
      await it1.next();

      await expect(
        limitedModel.stream([{ role: "user", content: "b" }]).next(),
      ).rejects.toMatchObject({
        name: "RateLimitExceededError",
        code: 429,
        reason: "concurrency",
        failedRule: concurrencyRule,
      });

      try {
        await limitedModel.stream([{ role: "user", content: "c" }]).next();
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitExceededError);
        expect((err as RateLimitExceededError).failedRule?.key).toBe("model-test:conc");
      }
    });

    it("augmentModel(mock, [withLimit]) enforces request rule and error carries failedRule", async () => {
      const requestRule: RateLimitRule = {
        type: "request",
        key: "model-test:req",
        limit: 1,
        windowMs: baseWindowMs,
      };
      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      mock.setDefaultUsage({ totalTokens: 1 });

      const limitedModel = augmentModel(mock.adapter, [withLimit({ store, rules: [requestRule] })]);

      const it1 = limitedModel.stream([{ role: "user", content: "a" }]);
      for await (const _ of it1) {
      }

      await expect(
        limitedModel.stream([{ role: "user", content: "b" }]).next(),
      ).rejects.toMatchObject({
        name: "RateLimitExceededError",
        reason: "request",
        failedRule: requestRule,
      });
    });

    it("concurrent streams lifecycle: properly enforces limits, tracks usage, and releases slots under pressure", async () => {
      const concurrencyRule: RateLimitRule = {
        type: "concurrency",
        key: "model-test:race:conc",
        limit: 5,
      };
      const tokenRule: RateLimitRule = {
        type: "token",
        key: "model-test:race:token",
        limit: 1000,
        windowMs: baseWindowMs,
      };

      const mock = createMockModel();
      mock.setDefaultResponse("ok");
      mock.setDefaultUsage({ totalTokens: 10 });

      const limitedModel = augmentModel(mock.adapter, [
        withLimit({
          store,
          rules: [concurrencyRule, tokenRule],
          calculatePreDeduct: () => 5,
        }),
      ] as Parameters<typeof augmentModel>[1]);

      const requests = Array.from({ length: 20 }, async (_, i) => {
        try {
          const stream = limitedModel.stream([{ role: "user", content: `msg-${i}` }]);
          const chunks: unknown[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          return { allowed: true, chunks };
        } catch (err) {
          if (err instanceof RateLimitExceededError) {
            return { allowed: false, reason: err.reason };
          }
          throw err;
        }
      });

      const results = await Promise.all(requests);

      const successCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      expect(successCount).toBe(5);
      expect(rejectedCount).toBe(15);
      expect(results.filter((r) => r.reason === "concurrency").length).toBe(15);

      const afterStream = limitedModel.stream([{ role: "user", content: "after" }]);
      const afterChunks: unknown[] = [];
      for await (const chunk of afterStream) {
        afterChunks.push(chunk);
      }
      expect(afterChunks.length).toBeGreaterThan(0);
    });
  });
}
