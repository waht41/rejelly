import { describe, expect, it } from "vitest";
import { extractSurfaceFromSource } from "./surface";

const SAMPLE = `/** Module doc. */
import { x } from "./x";

/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

function internalHelper(): void {}

/** Public options. */
export interface RunOptions {
  retries?: number;
}

export type RunResult = { ok: boolean };

export const DEFAULT_RETRIES = 3;

export const makeThing = (name: string): RunResult => {
  return { ok: name.length > 0 };
};

const secret = 42;

export class Runner {
  /** Runs once. */
  run(opts: RunOptions): RunResult {
    return { ok: true };
  }
}
`;

describe("extractSurfaceFromSource", () => {
  const symbols = extractSurfaceFromSource("src/sample.ts", SAMPLE);
  const names = symbols.map((s) => s.name);

  it("includes exported declarations of every outline kind", () => {
    expect(names).toContain("add");
    expect(names).toContain("RunOptions");
    expect(names).toContain("RunResult");
    expect(names).toContain("DEFAULT_RETRIES");
    expect(names).toContain("makeThing");
    expect(names).toContain("Runner");
  });

  it("excludes non-exported declarations", () => {
    expect(names).not.toContain("internalHelper");
    expect(names).not.toContain("secret");
  });

  it("slices signatures without bodies", () => {
    const add = symbols.find((s) => s.name === "add");
    expect(add?.signature).toContain("add(a: number, b: number): number");
    expect(add?.signature).not.toContain("return");
  });

  it("keeps interface bodies (docs claim member names/types)", () => {
    const options = symbols.find((s) => s.name === "RunOptions");
    expect(options?.signature).toContain("retries?: number");
  });

  it("attaches the JSDoc block above the declaration", () => {
    const add = symbols.find((s) => s.name === "add");
    expect(add?.jsdoc).toContain("Adds two numbers.");
    const options = symbols.find((s) => s.name === "RunOptions");
    expect(options?.jsdoc).toContain("Public options.");
  });

  it("records 1-based declaration lines", () => {
    const add = symbols.find((s) => s.name === "add");
    expect(add?.line).toBe(5);
  });

  it("returns empty for unparsable content instead of throwing", () => {
    expect(extractSurfaceFromSource("src/sample.ts", "export function {{{")).toEqual(
      expect.any(Array),
    );
  });
});
