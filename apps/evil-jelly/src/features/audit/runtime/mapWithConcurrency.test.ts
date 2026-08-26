import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    const startedOrder: number[] = [];
    const completionOrder: number[] = [];
    const items = [0, 1, 2, 3, 4, 5];
    const starts = items.map(deferred);
    const releases = items.map(deferred);
    const running = mapWithConcurrency(items, 3, async (_item, i) => {
      active++;
      peak = Math.max(peak, active);
      startedOrder.push(i);
      starts[i]!.resolve();
      await releases[i]!.promise;
      active--;
      completionOrder.push(i);
      return i;
    });

    await Promise.all(starts.slice(0, 3).map((start) => start.promise));
    expect(startedOrder).toEqual([0, 1, 2]);
    expect(peak).toBe(3);

    // Keep item 0 pending. Once item 1 settles, its worker must claim item 3 immediately instead
    // of waiting for the earlier item 0 to finish.
    releases[1]!.resolve();
    await starts[3]!.promise;

    expect(startedOrder).toEqual([0, 1, 2, 3]);
    expect(completionOrder).toEqual([1]);
    expect(completionOrder).not.toContain(0);
    expect(peak).toBeLessThanOrEqual(3);

    for (const release of releases) {
      release.resolve();
    }
    expect(await running).toEqual(items);
    expect(active).toBe(0);
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
