import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("audit mapWithConcurrency", () => {
  it("returns results in input order despite out-of-order completion", async () => {
    const input = [30, 10, 20, 5];
    const results = await mapWithConcurrency(input, 4, async (ms) => {
      await tick(ms);
      return ms * 2;
    });
    expect(results).toEqual([60, 20, 40, 10]);
  });

  it("never exceeds the concurrency limit and has no head-of-line blocking", async () => {
    let active = 0;
    let peak = 0;
    const completionOrder: number[] = [];
    // Item 0 is slow; with a sliding window it would stall item 4. The pool must let fast
    // items finish first while item 0 runs.
    const durations = [100, 10, 10, 10, 10, 10];
    await mapWithConcurrency(durations, 3, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await tick(ms);
      active--;
      completionOrder.push(i);
      return i;
    });
    expect(peak).toBeLessThanOrEqual(3);
    // The slow first item completes last, after items the window would have blocked behind it.
    expect(completionOrder[completionOrder.length - 1]).toBe(0);
    expect(completionOrder).toContain(4);
  });

  it("invokes onSettled once per item with a monotonically increasing completed count", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (n) => {
        await tick(n);
        return n;
      },
      (_result, _item, completed, total) => {
        expect(total).toBe(5);
        seen.push(completed);
      },
    );
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles an empty input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("clamps concurrency to a sane minimum", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1);
    expect(results).toEqual([2, 3, 4]);
  });
});
