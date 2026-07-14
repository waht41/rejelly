/**
 * Hash tag tests for RedisStore key construction. Uses a fake RedisLike that records eval calls,
 * so no real Redis is needed — we only assert the keys sent to scripts and the pre-flight guards.
 */

import { describe, expect, it } from "vitest";
import type { RateLimitRule } from "../../../rule.js";
import { DEFAULT_HASH_TAG, RedisStore, toRedisKey } from "../store.js";
import type { RedisLike } from "../types.js";

/** allowed=1 response shaped like CONSUME_SCRIPT / RELEASE_CONCURRENCY_SCRIPT results. */
function fakeRedis(): RedisLike & { calls: { keys: string[] }[] } {
  const calls: { keys: string[] }[] = [];
  return {
    calls,
    eval(_script: string, numKeys: number, ...args: (string | number)[]) {
      calls.push({ keys: args.slice(0, numKeys).map(String) });
      return Promise.resolve([1]);
    },
  };
}

const tenantRule: RateLimitRule = {
  type: "request",
  key: "tenantA:gpt-4",
  limit: 10,
  windowMs: 1000,
};
const globalRule: RateLimitRule = { type: "concurrency", key: "gpt-4", limit: 5 };

const tenantOf = (rule: RateLimitRule) => rule.key.split(":")[0];

describe("toRedisKey", () => {
  it("defaults to the fixed tag and accepts a custom one", () => {
    expect(toRedisKey(tenantRule)).toBe(`{${DEFAULT_HASH_TAG}}:tenantA:gpt-4:request`);
    expect(toRedisKey(tenantRule, "tenantA")).toBe("{tenantA}:tenantA:gpt-4:request");
  });
});

describe("RedisStore hashTag option", () => {
  it("uses the default tag when omitted", async () => {
    const redis = fakeRedis();
    await new RedisStore(redis).consume([tenantRule], 0, "req-1");
    expect(redis.calls[0].keys).toEqual([`{${DEFAULT_HASH_TAG}}:tenantA:gpt-4:request`]);
  });

  it("applies a string tag to every key", async () => {
    const redis = fakeRedis();
    await new RedisStore(redis, { hashTag: "deploy-b", prefix: "p" }).consume(
      [tenantRule, globalRule],
      0,
      "req-1",
    );
    expect(redis.calls[0].keys).toEqual([
      "p:{deploy-b}:tenantA:gpt-4:request",
      "p:{deploy-b}:gpt-4:concurrency",
    ]);
  });

  it("derives per-rule tags from a function", async () => {
    const redis = fakeRedis();
    const rules: RateLimitRule[] = [tenantRule, { type: "concurrency", key: "tenantA", limit: 3 }];
    await new RedisStore(redis, { hashTag: tenantOf }).consume(rules, 0, "req-1");
    expect(redis.calls[0].keys).toEqual([
      "{tenantA}:tenantA:gpt-4:request",
      "{tenantA}:tenantA:concurrency",
    ]);
  });

  it("rejects mixed tags within one consume call before reaching Redis", async () => {
    const redis = fakeRedis();
    const store = new RedisStore(redis, { hashTag: tenantOf });
    await expect(store.consume([tenantRule, globalRule], 0, "req-1")).rejects.toThrow(
      /share a hash tag/,
    );
    expect(redis.calls).toHaveLength(0);
  });

  it("rejects mixed tags within one releaseConcurrency call", async () => {
    const redis = fakeRedis();
    const store = new RedisStore(redis, { hashTag: tenantOf });
    await expect(
      store.releaseConcurrency(
        [
          { type: "concurrency", key: "tenantA", limit: 3 },
          { type: "concurrency", key: "tenantB", limit: 3 },
        ],
        "req-1",
      ),
    ).rejects.toThrow(/share a hash tag/);
    expect(redis.calls).toHaveLength(0);
  });

  it("rejects invalid tags (empty or containing braces)", async () => {
    expect(() => new RedisStore(fakeRedis(), { hashTag: "" })).toThrow(/Invalid hash tag/);
    expect(() => new RedisStore(fakeRedis(), { hashTag: "a}b" })).toThrow(/Invalid hash tag/);
    const store = new RedisStore(fakeRedis(), { hashTag: () => "{oops" });
    await expect(store.consume([tenantRule], 0, "req-1")).rejects.toThrow(/Invalid hash tag/);
  });
});
