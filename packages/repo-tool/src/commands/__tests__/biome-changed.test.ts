import { describe, expect, it } from "vitest";
import { chunkBiomePaths } from "../biome-changed.js";

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
