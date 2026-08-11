import { describe, expect, it } from "vitest";
import { detectCloneCandidatesFromSources } from "./cloneCandidates";

/** Same logic, renamed identifiers/literals — a textbook Type-2 clone. */
const ORDERS = `
export function computeTotals(orders) {
  let total = 0;
  let count = 0;
  for (const order of orders) {
    if (order.status === "paid") {
      total = total + order.amount;
      count = count + 1;
    }
  }
  const average = count > 0 ? total / count : 0;
  return { total, count, average };
}
`;

const SALES = `
export function aggregateSales(records) {
  let sum = 0;
  let num = 0;
  for (const record of records) {
    if (record.state === "closed") {
      sum = sum + record.value;
      num = num + 1;
    }
  }
  const mean = num > 0 ? sum / num : 0;
  return { sum, num, mean };
}
`;

describe("detectCloneCandidatesFromSources", () => {
  it("clusters a renamed (Type-2) duplicate across two files", () => {
    const report = detectCloneCandidatesFromSources([
      { file: "src/a.ts", code: `const unrelatedA = 1;\n${ORDERS}` },
      { file: "src/b.ts", code: `const unrelatedB = 2;\n${SALES}` },
    ]);

    expect(report.stats.filesParsed).toBe(2);
    expect(report.clusters.length).toBeGreaterThanOrEqual(1);

    const top = report.clusters[0];
    expect(top.fileCount).toBe(2);
    expect(top.fragments.length).toBe(2);
    expect(new Set(top.fragments.map((f) => f.file))).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    for (const frag of top.fragments) {
      expect(frag.endLine).toBeGreaterThanOrEqual(frag.startLine);
      expect(frag.lines).toBe(frag.endLine - frag.startLine + 1);
    }
  });

  it("does not report unrelated files", () => {
    const report = detectCloneCandidatesFromSources([
      { file: "src/a.ts", code: ORDERS },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source fixture, not interpolation
      { file: "src/b.ts", code: "export const greeting = (who) => `hi ${who}`;\n" },
    ]);
    expect(report.clusters.length).toBe(0);
  });

  it("excludes clones that live entirely in test/generated paths by default", () => {
    const sources = [
      { file: "src/a.test.ts", code: ORDERS },
      { file: "src/b.test.ts", code: SALES },
    ];
    expect(detectCloneCandidatesFromSources(sources).clusters.length).toBe(0);
    // ...but surfaces them when the filter is disabled.
    const withTests = detectCloneCandidatesFromSources(sources, {
      excludeTestAndGenerated: false,
    });
    expect(withTests.clusters.length).toBeGreaterThanOrEqual(1);
  });

  it("respects the maxClusters cap", () => {
    const report = detectCloneCandidatesFromSources(
      [
        { file: "src/a.ts", code: ORDERS },
        { file: "src/b.ts", code: SALES },
        { file: "src/c.ts", code: ORDERS },
      ],
      { maxClusters: 1 },
    );
    expect(report.clusters.length).toBeLessThanOrEqual(1);
  });
});
