import { vi } from "vitest";
import { defineModelTestSuite } from "../../../__tests__/model-test-suite.js";
import { defineMultiRuleAndFailedRuleSuite } from "../../../__tests__/multi-rule-and-failed-rule-suite.js";
import { defineStoreTestSuite } from "../../../__tests__/store-suite.js";
import { MemoryStore } from "../store.js";

vi.useFakeTimers();

let storeRef: MemoryStore | null = null;

const memoryStoreOptions = {
  setupStore: () => {
    storeRef = new MemoryStore();
    return storeRef;
  },
  cleanupStore: () => {
    storeRef?.destroy();
    storeRef = null;
  },
  advanceTime: async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  },
  baseWindowMs: 60000,
};

defineStoreTestSuite("MemoryStore", memoryStoreOptions);
defineMultiRuleAndFailedRuleSuite("MemoryStore", memoryStoreOptions);
defineModelTestSuite("MemoryStore", memoryStoreOptions);
