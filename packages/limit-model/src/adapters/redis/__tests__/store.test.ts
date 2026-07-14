import Redis from "ioredis";
import { afterAll, describe } from "vitest";
import { defineModelTestSuite } from "../../../__tests__/model-test-suite.js";
import { defineMultiRuleAndFailedRuleSuite } from "../../../__tests__/multi-rule-and-failed-rule-suite.js";
import { defineStoreTestSuite } from "../../../__tests__/store-suite.js";
import { RedisStore } from "../store.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/1";
const redisClient = new Redis(redisUrl);

function randomPrefix(): string {
  return `store-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const redisStoreOptions = {
  setupStore: async () => new RedisStore(redisClient, { prefix: randomPrefix() }),
  cleanupStore: async () => {},
  advanceTime: async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
  baseWindowMs: 150,
};

describe.skipIf(!process.env.REDIS_TEST)("RedisStore", () => {
  defineStoreTestSuite("RedisStore", redisStoreOptions);
  defineMultiRuleAndFailedRuleSuite("RedisStore", redisStoreOptions);
  defineModelTestSuite("RedisStore", redisStoreOptions);
});

afterAll(() => redisClient.disconnect());
