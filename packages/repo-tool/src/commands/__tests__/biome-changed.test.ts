import { describe, expect, it } from "vitest";
import { chunkBiomePaths, exceedsBiomeWriteLimit, runBiomeBatches } from "../biome-changed.js";

describe("chunkBiomePaths", () => {
  it("preserves path order and splits before the argument budget", () => {
    const files = ["a.ts", "long/path/b.ts", "c.ts"];
    const batches = chunkBiomePaths(files, 22);

    expect(batches).toEqual([["a.ts"], ["long/path/b.ts"], ["c.ts"]]);
    expect(batches.flat()).toEqual(files);
  });

  it("keeps one oversized path as a runnable batch", () => {
    expect(chunkBiomePaths(["very-long-file-name.ts"], 4)).toEqual([["very-long-file-name.ts"]]);
  });
});

describe("exceedsBiomeWriteLimit", () => {
  it("limits writes but never blocks a read-only check", () => {
    expect(exceedsBiomeWriteLimit(101, { allowMany: false, maxFiles: 100, write: false })).toBe(
      false,
    );
    expect(exceedsBiomeWriteLimit(101, { allowMany: false, maxFiles: 100, write: true })).toBe(
      true,
    );
    expect(exceedsBiomeWriteLimit(101, { allowMany: true, maxFiles: 100, write: true })).toBe(
      false,
    );
  });
});

describe("runBiomeBatches", () => {
  it("collects failures from every batch instead of stopping after the first diagnostic", async () => {
    const visited: number[] = [];
    const result = await runBiomeBatches([["a.ts"], ["b.ts"], ["c.ts"]], async (_batch, index) => {
      visited.push(index);
      return {
        cancelled: false,
        output: `batch ${index}`,
        status: index === 1 ? 0 : 1,
        stderr: "",
        stdout: "",
        timedOut: false,
      };
    });

    expect(visited).toEqual([0, 1, 2]);
    expect(result.failures.map((failure) => failure.batch)).toEqual([1, 3]);
    expect(result.status).toBe(1);
  });

  it("stops after cancellation because the parent operation is no longer active", async () => {
    const visited: number[] = [];
    await runBiomeBatches([["a.ts"], ["b.ts"]], async (_batch, index) => {
      visited.push(index);
      return {
        cancelled: true,
        output: "",
        status: 130,
        stderr: "",
        stdout: "",
        timedOut: false,
      };
    });
    expect(visited).toEqual([0]);
  });
});
