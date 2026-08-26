import { describe, expect, it } from "vitest";
import { normalizeVerifyOptions } from "../cli.js";

describe("normalizeVerifyOptions", () => {
  it("defaults to affected packages and changed-file Biome", () => {
    expect(normalizeVerifyOptions({})).toMatchObject({
      biome: "changed",
      fix: false,
      fixBranch: false,
      relatedTests: false,
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

  it("enables related tests as an explicit fast mode", () => {
    expect(normalizeVerifyOptions({ relatedTests: true }).relatedTests).toBe(true);
  });

  it("rejects related tests with incompatible test scopes", () => {
    expect(() => normalizeVerifyOptions({ all: true, relatedTests: true })).toThrow(
      "--related-tests cannot be combined with --all",
    );
    expect(() => normalizeVerifyOptions({ relatedTests: true, tests: false })).toThrow(
      "--related-tests cannot be combined with --no-tests",
    );
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

  it("enables structured output and converts the step timeout to milliseconds", () => {
    expect(normalizeVerifyOptions({ json: true, timeout: "12" })).toMatchObject({
      json: true,
      timeoutMs: 12_000,
    });
  });

  it("requires --fix before widening writes to the whole branch", () => {
    expect(() => normalizeVerifyOptions({ branch: true })).toThrow("--branch requires --fix");
    expect(normalizeVerifyOptions({ branch: true, fix: true }).fixBranch).toBe(true);
  });

  it("rejects fixing when Biome is disabled", () => {
    expect(() => normalizeVerifyOptions({ biome: "skip", fix: true })).toThrow(
      "--fix cannot be combined with --biome skip",
    );
  });
});
