/**
 * Reborn Mechanism Tests
 *
 * Tests for the reborn() function and state persistence
 */

import { describe, expect, it } from "vitest";
import { createMockModel, schemas } from "../../testing/helpers";
import { isRebornLimitExceededError, RebornLimitExceededError } from "../domain/errors";
import { createAgent } from "../engine/agent";
import { isRebornSignal, reborn } from "../engine/flow/reborn";
import { equipMemory } from "../facade/equip/memory";
import { promptAgent } from "../policy/prompt-schema";
import { REBORN_SIGNAL } from "../shared/symbols";

describe("reborn mechanism", () => {
  describe("basic reborn", () => {
    it("re-executes handler on reborn()", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      let runCount = 0;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          runCount++;
          if (runCount === 1) return reborn();
          return promptAgent(schemas.done);
        },
      });

      await agent({});
      expect(runCount).toBe(2);
    });

    it("isRebornSignal identifies reborn result", () => {
      expect(isRebornSignal(reborn())).toBe(true);
      expect(isRebornSignal({ done: true })).toBe(false);
      expect(isRebornSignal(null)).toBe(false);
    });

    it("REBORN_SIGNAL is unique symbol", () => {
      const signal = reborn();
      expect(signal[REBORN_SIGNAL]).toBe(true);
    });
  });

  describe("state persistence across reborn", () => {
    it("equipMemory persists across reborn", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      const capturedValues: number[] = [];

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [count, setCount] = equipMemory("count", 0);
          capturedValues.push(count);

          if (count < 3) {
            setCount(count + 1);
            return reborn();
          }
          return promptAgent(schemas.done);
        },
      });

      await agent({});
      expect(capturedValues).toEqual([0, 1, 2, 3]);
    });

    it("setState + reborn() updates state", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      const capturedValues: { count: number; name: string }[] = [];

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [count, setCount] = equipMemory("count", 0);
          const [name, setName] = equipMemory("name", "initial");
          capturedValues.push({ count, name });

          if (count === 0) {
            setCount(100);
            setName("updated");
            return reborn();
          }
          return promptAgent(schemas.done);
        },
      });

      await agent({});
      expect(capturedValues).toEqual([
        { count: 0, name: "initial" },
        { count: 100, name: "updated" },
      ]);
    });

    it("setState partial update preserves other state", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      let finalState: { a: number; b: string } | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [a, setA] = equipMemory("a", 1);
          const [b] = equipMemory("b", "hello");

          if (a === 1) {
            setA(99); // only update a
            return reborn();
          }

          finalState = { a, b };
          return promptAgent(schemas.done);
        },
      });

      await agent({});
      expect(finalState).toEqual({ a: 99, b: "hello" });
    });
  });

  describe("state isolation", () => {
    it("state resets between agent calls", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      const capturedValues: number[] = [];

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [count, setCount] = equipMemory("count", 0);
          capturedValues.push(count);
          setCount(100);
          return promptAgent(schemas.done);
        },
      });

      await agent({});
      await agent({});
      await agent({});

      // Each call starts fresh at 0
      expect(capturedValues).toEqual([0, 0, 0]);
    });

    it("parallel agents have isolated state", async () => {
      const mock1 = createMockModel();
      const mock2 = createMockModel();
      mock1.setDefaultResponse({ done: true });
      mock2.setDefaultResponse({ done: true });

      const captured1: number[] = [];
      const captured2: number[] = [];

      const agent1 = createAgent({
        id: "test1",
        model: mock1.adapter,
        handler: async () => {
          const [count, setCount] = equipMemory("count", 100);
          captured1.push(count);
          setCount(count + 1);
          const [newCount] = equipMemory("count", 0);
          captured1.push(newCount);
          return promptAgent(schemas.done);
        },
      });

      const agent2 = createAgent({
        id: "test2",
        model: mock2.adapter,
        handler: async () => {
          const [count, setCount] = equipMemory("count", 200);
          captured2.push(count);
          setCount(count + 1);
          const [newCount] = equipMemory("count", 0);
          captured2.push(newCount);
          return promptAgent(schemas.done);
        },
      });

      await Promise.all([agent1({}), agent2({})]);

      expect(captured1).toEqual([100, 101]);
      expect(captured2).toEqual([200, 201]);
    });
  });

  describe("functional updates", () => {
    it("setMemory accepts function updater", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      let finalValue: number | null = null;

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () => {
          const [_count, setCount] = equipMemory("count", 10);

          setCount((prev) => prev + 1);
          setCount((prev) => prev * 2);

          const [newCount] = equipMemory("count", 0);
          finalValue = newCount;
          return promptAgent(schemas.done);
        },
      });

      await agent({});
      expect(finalValue).toBe(22); // (10 + 1) * 2
    });
  });

  describe("maxReborns guard", () => {
    it("throws RebornLimitExceededError when a reborn loop never converges", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      let runCount = 0;
      const agent = createAgent({
        id: "runaway",
        model: mock.adapter,
        maxReborns: 3,
        handler: async () => {
          runCount++;
          return reborn(); // never converges
        },
      });

      await expect(agent({})).rejects.toBeInstanceOf(RebornLimitExceededError);
      // gen 0..3 ran (initial + 3 reborns); the 4th reborn request is refused
      expect(runCount).toBe(4);
    });

    it("error carries maxReborns and attemptedReborns (maxReborns + 1)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      const agent = createAgent({
        id: "runaway",
        model: mock.adapter,
        maxReborns: 2,
        handler: async () => reborn(),
      });

      const err = (await agent({}).catch((e) => e)) as RebornLimitExceededError;
      expect(isRebornLimitExceededError(err)).toBe(true);
      expect(err.maxReborns).toBe(2);
      expect(err.attemptedReborns).toBe(3);
    });

    it("allows exactly maxReborns reborns (maxReborns + 1 generations)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      let runCount = 0;
      const agent = createAgent({
        id: "bounded",
        model: mock.adapter,
        maxReborns: 3,
        handler: async () => {
          runCount++;
          const [n, setN] = equipMemory("n", 0);
          if (n < 3) {
            setN(n + 1);
            return reborn();
          }
          return promptAgent(schemas.done);
        },
      });

      const result = await agent({});
      expect(runCount).toBe(4); // gen 0..3 = 3 reborns
      expect(result).toEqual({ done: true });
    });

    it("does not trip when an equipMemory counter converges within the limit", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ done: true });

      const agent = createAgent({
        id: "converges",
        model: mock.adapter,
        handler: async () => {
          const [n, setN] = equipMemory("n", 0);
          if (n < 5) {
            setN(n + 1);
            return reborn();
          }
          return promptAgent(schemas.done);
        },
      });

      // Default maxReborns (100) is generous; a 5-reborn convergent loop must succeed.
      await expect(agent({})).resolves.toEqual({ done: true });
    });
  });
});
