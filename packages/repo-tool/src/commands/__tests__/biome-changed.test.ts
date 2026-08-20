import { describe, expect, it } from "vitest";
import { chunkBiomePaths, exceedsBiomeWriteLimit } from "../biome-changed.js";

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
