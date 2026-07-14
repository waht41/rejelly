/**
 * Concurrency lease (renew) tests for RedisStore.
 * Verifies that lease.renew() extends TTL and that slots are reclaimed when heartbeat stops.
 */

import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RedisStore } from "../store.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/1";
const redisClient = new Redis(redisUrl);

const LEASE_TIMEOUT_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPrefix(): string {
  return `lease-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!process.env.REDIS_TEST)("RedisStore lease renew", () => {
  let store: RedisStore;

  beforeEach(() => {
    store = new RedisStore(redisClient, {
      prefix: randomPrefix(),
      maxConcurrencyTimeoutMs: LEASE_TIMEOUT_MS,
    });
  });

  afterAll(() => redisClient.disconnect());

  it("lease.renew() extends TTL so slot is still held after original expiry", async () => {
    const rule = { type: "concurrency" as const, key: "lease:renew:key", limit: 1 };

    const r1 = await store.consume([rule], 0, "req-1");
    expect(r1.allowed).toBe(true);
    expect(r1.lease).toBeDefined();

    await sleep(400);
    await r1.lease!.renew();
    await sleep(400);
    await r1.lease!.renew();

    await sleep(LEASE_TIMEOUT_MS - 200);
    const r2 = await store.consume([rule], 0, "req-2");
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("concurrency");
  });

  it("when heartbeat stops, slot is reclaimed after maxConcurrencyTimeoutMs", async () => {
    const rule = { type: "concurrency" as const, key: "lease:reclaim:key", limit: 1 };

    const r1 = await store.consume([rule], 0, "req-1");
    expect(r1.allowed).toBe(true);
    expect(r1.lease).toBeDefined();
    // Simulate dead process: no renew(), no releaseConcurrency()

    await sleep(LEASE_TIMEOUT_MS + 300);

    const r2 = await store.consume([rule], 0, "req-2");
    expect(r2.allowed).toBe(true);
  });
});
