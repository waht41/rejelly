/**
 * Standalone benchmark for RedisStore Lua script throughput.
 * Run with: pnpm run benchmark  or  tsx bench/redis-store.bench.ts
 * Do NOT run inside Vitest — use this script to measure Redis/Lua QPS without test framework overhead.
 */

import Redis from "ioredis";
import { RedisStore } from "../src/adapters/redis/store.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/1";
const redis = new Redis(redisUrl);

const store = new RedisStore(redis);

const TOTAL_REQUESTS = Number(process.env.BENCH_TOTAL) || 100_000;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY) || 2000;

async function runBenchmark() {
  console.log(`Starting benchmark: ${TOTAL_REQUESTS} requests, ${CONCURRENCY} concurrency...`);

  await redis.flushdb();

  const rules = [
    { type: "token" as const, key: "bench:tpm", limit: 1_000_000, windowMs: 60_000 },
    { type: "concurrency" as const, key: "bench:conc", limit: 1_000_000 },
  ];

  let completed = 0;
  const start = performance.now();

  const worker = async () => {
    while (completed < TOTAL_REQUESTS) {
      const n = ++completed;
      await store.consume(rules, 1, `req-${n}`);
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const end = performance.now();
  const elapsedMs = end - start;
  const qps = (TOTAL_REQUESTS / (elapsedMs / 1000)).toFixed(2);

  console.log("\n--- Benchmark Results ---");
  console.log(`Total Time: ${elapsedMs.toFixed(2)} ms`);
  console.log(`Total Requests: ${TOTAL_REQUESTS}`);
  console.log(`QPS: ${qps} req/sec`);

  await redis.quit();
}

runBenchmark().catch(console.error);
