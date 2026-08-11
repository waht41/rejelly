import { describe, expect, it } from "vitest";
import { detectComplexityCandidatesFromSources } from "./complexity";

/** A function body of `n` trivial statement lines. */
function body(n: number): string {
  return Array.from({ length: n }, (_, i) => `  const v${i} = ${i} + 1;`).join("\n");
}

describe("detectComplexityCandidates — size", () => {
  it("flags an over-long function with a line reason", () => {
    const code = `export function big() {\n${body(70)}\n  return 0;\n}\n`;
    const { findings } = detectComplexityCandidatesFromSources([{ file: "src/big.ts", code }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe("big");
    expect(findings[0].metrics.lines).toBeGreaterThanOrEqual(60);
    expect(findings[0].reasons.some((r) => r.includes("lines"))).toBe(true);
  });

  it("ignores small simple functions", () => {
    const code = `export function add(a, b) {\n  return a + b;\n}\n`;
    const { findings } = detectComplexityCandidatesFromSources([{ file: "src/small.ts", code }]);
    expect(findings).toHaveLength(0);
  });
});

describe("detectComplexityCandidates — nesting & branching", () => {
  it("flags deep control-flow nesting", () => {
    const code = `export function deep(xs) {
  for (const x of xs) {
    if (x > 0) {
      while (x < 10) {
        if (x % 2 === 0) {
          doThing(x);
        }
      }
    }
  }
  return xs;
}
`;
    const { findings } = detectComplexityCandidatesFromSources([{ file: "src/deep.ts", code }], {
      maxLines: 1000,
      maxBranches: 1000,
      maxParams: 1000,
      minLines: 5,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].metrics.maxDepth).toBeGreaterThanOrEqual(4);
    expect(findings[0].reasons.some((r) => r.includes("nesting"))).toBe(true);
  });

  it("flags too many parameters", () => {
    const code = `export function many(a, b, c, d, e, f, g) {\n${body(12)}\n}\n`;
    const { findings } = detectComplexityCandidatesFromSources([{ file: "src/many.ts", code }], {
      maxLines: 1000,
      maxDepth: 1000,
      maxBranches: 1000,
      minLines: 5,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].metrics.params).toBe(7);
  });
});

describe("detectComplexityCandidates — outermost only", () => {
  it("reports an over-long function once, not its inner closures too", () => {
    const code = `export function outer() {
  const cb = () => {
${body(70)}
    return 1;
  };
  return cb;
}
`;
    const { findings } = detectComplexityCandidatesFromSources([{ file: "src/outer.ts", code }]);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe("outer");
  });
});

describe("detectComplexityCandidates — filtering", () => {
  it("excludes test/generated paths", () => {
    const code = `export function big() {\n${body(70)}\n}\n`;
    const { findings } = detectComplexityCandidatesFromSources([
      { file: "src/big.test.ts", code },
      { file: "dist/big.ts", code },
    ]);
    expect(findings).toHaveLength(0);
  });

  it("ranks worse functions first", () => {
    const small = `export function s() {\n${body(65)}\n}\n`;
    const huge = `export function h(xs) {
  for (const x of xs) {
    if (x) {
      while (x) {
        if (x) {
${body(70)}
        }
      }
    }
  }
}
`;
    const { findings } = detectComplexityCandidatesFromSources([
      { file: "src/s.ts", code: small },
      { file: "src/h.ts", code: huge },
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings[0].name).toBe("h");
  });
});
