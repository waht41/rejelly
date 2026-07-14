/**
 * Async Utilities Tests
 *
 * Tests for async primitives functionality.
 */

import { describe, expect, it, vi } from "vitest";
import { parallel, race, retry, sleep, timeout, waitUntil } from "../async";

// ============ Functionality Tests ============

describe("Async Utilities - Functionality", () => {
  describe("sleep", () => {
    it("should sleep for specified duration", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
    });

    it("should reject when signal is aborted", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await expect(sleep(1000, { signal: controller.signal })).rejects.toThrow("Aborted");
    });

    it("should reject immediately if signal already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(sleep(1000, { signal: controller.signal })).rejects.toThrow("Aborted");
    });
  });

  describe("timeout", () => {
    it("should reject after specified duration", async () => {
      const start = Date.now();
      await expect(timeout(50)).rejects.toThrow("Timeout");
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it("should use custom message", async () => {
      await expect(timeout(10, { message: "Custom timeout" })).rejects.toThrow("Custom timeout");
    });

    it("should reject when signal is aborted", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await expect(timeout(1000, { signal: controller.signal })).rejects.toThrow("Aborted");
    });
  });

  describe("retry", () => {
    it("should succeed on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await retry(fn);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("success");

      const result = await retry(fn, { delay: 10, maxAttempts: 3 });
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after max attempts", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fail"));

      await expect(retry(fn, { delay: 10, maxAttempts: 2 })).rejects.toThrow("always fail");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("should respect shouldRetry predicate", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("no retry"));

      await expect(
        retry(fn, {
          delay: 10,
          maxAttempts: 3,
          shouldRetry: () => false,
        }),
      ).rejects.toThrow("no retry");

      expect(fn).toHaveBeenCalledTimes(1); // Only 1 attempt
    });

    it("should abort on signal", async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error("fail"));

      // Abort after a short delay
      setTimeout(() => controller.abort(), 5);

      // Should abort during the delay between retries
      await expect(
        retry(fn, { delay: 100, maxAttempts: 3, signal: controller.signal }),
      ).rejects.toThrow("Aborted");
    });
  });

  describe("race", () => {
    it("should return first resolved promise", async () => {
      const fast = Promise.resolve("fast");
      const slow = new Promise((r) => setTimeout(() => r("slow"), 100));

      const result = await race([fast, slow], { timeout: 1000 });
      expect(result).toBe("fast");
    });

    it("should timeout if all promises are slower", async () => {
      const slow1 = new Promise((r) => setTimeout(() => r("slow1"), 100));
      const slow2 = new Promise((r) => setTimeout(() => r("slow2"), 100));

      await expect(race([slow1, slow2], { timeout: 10 })).rejects.toThrow("Timeout");
    });

    it("should propagate first error", async () => {
      const error = Promise.reject(new Error("boom"));
      const slow = new Promise((r) => setTimeout(() => r("slow"), 100));

      await expect(race([error, slow], { timeout: 1000 })).rejects.toThrow("boom");
    });

    it("should reject when signal is aborted", async () => {
      const controller = new AbortController();
      const slow = new Promise((r) => setTimeout(() => r("slow"), 1000));

      setTimeout(() => controller.abort(), 10);

      await expect(race([slow], { timeout: 5000, signal: controller.signal })).rejects.toThrow(
        "Aborted",
      );
    });
  });

  describe("parallel", () => {
    it("should run all tasks and return results", async () => {
      const tasks = [() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)];

      const results = await parallel(tasks, { concurrency: Infinity });

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("fulfilled");
      expect(results[0].index).toBe(0);
      expect((results[0] as { status: "fulfilled"; value: number }).value).toBe(1);
      expect(results[1].status).toBe("fulfilled");
      expect(results[1].index).toBe(1);
      expect((results[1] as { status: "fulfilled"; value: number }).value).toBe(2);
      expect(results[2].status).toBe("fulfilled");
      expect(results[2].index).toBe(2);
      expect((results[2] as { status: "fulfilled"; value: number }).value).toBe(3);
    });

    it("should handle errors without stopOnError", async () => {
      const tasks = [
        () => Promise.resolve("ok"),
        () => Promise.reject(new Error("fail")),
        () => Promise.resolve("ok2"),
      ];

      const results = await parallel(tasks, { concurrency: Infinity });

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[2].status).toBe("fulfilled");
    });

    it("should stop on first error with stopOnError", async () => {
      const tasks = [() => Promise.reject(new Error("fail")), () => Promise.resolve("ok")];

      await expect(parallel(tasks, { concurrency: Infinity, stopOnError: true })).rejects.toThrow(
        "fail",
      );
    });

    it("should respect concurrency limit", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const createTask = () => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(20);
        concurrent--;
        return "done";
      };

      const tasks = Array.from({ length: 5 }, createTask);
      await parallel(tasks, { concurrency: 2 });

      expect(maxConcurrent).toBe(2);
    });

    it("should handle sync errors correctly", async () => {
      const tasks = [
        () => Promise.resolve("ok"),
        () => {
          throw new Error("Sync error!");
        },
        () => Promise.resolve("ok2"),
      ];

      const results = await parallel(tasks, { concurrency: Infinity });

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect((results[1] as { status: "rejected"; reason: Error }).reason.message).toBe(
        "Sync error!",
      );
      expect(results[2].status).toBe("fulfilled");
    });

    it("should handle sync errors with concurrency limit", async () => {
      const tasks = [
        () => Promise.resolve("ok1"),
        () => {
          throw new Error("Boom!");
        }, // Sync error
        () => Promise.resolve("ok2"),
        () => Promise.resolve("ok3"),
      ];

      const results = await parallel(tasks, { concurrency: 2 });

      expect(results).toHaveLength(4);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    });

    it("should reject when signal is aborted before start", async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort

      const tasks = [() => Promise.resolve("ok")];

      await expect(
        parallel(tasks, { concurrency: Infinity, signal: controller.signal }),
      ).rejects.toThrow("Aborted");
    });

    it("should reject when signal is aborted during semaphore wait", async () => {
      const controller = new AbortController();

      // Create tasks that take time, limited concurrency ensures later tasks wait
      const tasks = [
        async () => {
          await sleep(50);
          return "task1";
        },
        async () => {
          await sleep(50);
          return "task2";
        },
        async () => {
          await sleep(50);
          return "task3";
        },
      ];

      // Abort while tasks are waiting for semaphore
      setTimeout(() => controller.abort(), 10);

      // With concurrency 1, task 2 and 3 will wait in semaphore queue
      await expect(parallel(tasks, { concurrency: 1, signal: controller.signal })).rejects.toThrow(
        "Aborted",
      );
    });
  });

  describe("waitUntil", () => {
    it("should resolve when condition becomes true", async () => {
      let count = 0;
      const condition = () => {
        count++;
        return count >= 3;
      };

      await waitUntil(condition, { interval: 10 });
      expect(count).toBe(3);
    });

    it("should timeout if condition never true", async () => {
      await expect(waitUntil(() => false, { interval: 10, timeout: 50 })).rejects.toThrow(
        "Timeout",
      );
    });

    it("should abort on signal", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      await expect(
        waitUntil(() => false, { interval: 10, signal: controller.signal }),
      ).rejects.toThrow("Aborted");
    });
  });
});
