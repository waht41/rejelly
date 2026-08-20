import { describe, expect, it } from "vitest";
import { normalizeVerifyOptions } from "../cli.js";

describe("normalizeVerifyOptions", () => {
  it("defaults to affected packages and changed-file Biome", () => {
    expect(normalizeVerifyOptions({})).toMatchObject({
      biome: "changed",
      fix: false,
      scope: { kind: "affected" },
      verbose: false,
    });
  });

  it("makes --all cover workspace tasks and Biome", () => {
    expect(normalizeVerifyOptions({ all: true })).toMatchObject({
      biome: "all",
      scope: { kind: "all" },
    });
  });

  it("lets an explicit Biome scope override --all", () => {
    expect(normalizeVerifyOptions({ all: true, biome: "skip" }).biome).toBe("skip");
  });

  it("uses repeatable filters as an explicit scope", () => {
    expect(normalizeVerifyOptions({ filter: ["a", "b"] }).scope).toEqual({
      filters: ["a", "b"],
      kind: "filtered",
    });
  });

  it("rejects ambiguous all-plus-filter scope", () => {
    expect(() => normalizeVerifyOptions({ all: true, filter: "a" })).toThrow(
      "--all cannot be combined with --filter",
    );
  });

  it("enables explicit safe fixing and verbose output", () => {
    expect(normalizeVerifyOptions({ fix: true, verbose: true })).toMatchObject({
      fix: true,
      verbose: true,
    });
  });

  it("rejects fixing when Biome is disabled", () => {
    expect(() => normalizeVerifyOptions({ biome: "skip", fix: true })).toThrow(
      "--fix cannot be combined with --biome skip",
    );
  });
});
