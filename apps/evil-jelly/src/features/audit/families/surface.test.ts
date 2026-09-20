import { describe, expect, it } from "vitest";
import { extractSurfaceFromSource, hashMappedImplementationSources } from "./surface";

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

describe("hashMappedImplementationSources", () => {
  it("changes when private implementation behavior changes", () => {
    const before = hashMappedImplementationSources([
      {
        file: "src/api.ts",
        text: "function cleanup(value: unknown) { return Boolean(value); }\nexport { cleanup };",
      },
    ]);
    const after = hashMappedImplementationSources([
      {
        file: "src/api.ts",
        text: "function cleanup(value: unknown) { return value != null; }\nexport { cleanup };",
      },
    ]);

    expect(after).not.toBe(before);
  });

  it("is stable when mapped files arrive in a different order", () => {
    const sources = [
      { file: "src/a.ts", text: "export const a = 1;" },
      { file: "src/b.ts", text: "export const b = 2;" },
    ];

    expect(hashMappedImplementationSources(sources)).toBe(
      hashMappedImplementationSources([...sources].reverse()),
    );
  });
});
