import { describe, expect, it } from "vitest";
import { detectFragmentationCandidatesFromSources } from "./fragmentation";

/** A small file body of `n` trivial export lines (keeps files under the micro threshold). */
function small(n: number): string {
  return Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n");
}

describe("detectFragmentationCandidates — single-consumer micro-cluster", () => {
  it("groups satellites that only one sibling host imports into one cluster", () => {
    const sources = [
      {
        file: "src/feature/host.ts",
        code: `import { a } from "./roleA";\nimport { b } from "./roleB";\nexport const host = a + b;\n`,
      },
      { file: "src/feature/roleA.ts", code: `export const a = 1;\n` },
      { file: "src/feature/roleB.ts", code: `export const b = 2;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.host).toBe("src/feature/host.ts");
    expect(cluster.satelliteCount).toBe(2);
    expect(cluster.members.map((m) => m.file)).toEqual([
      "src/feature/host.ts",
      "src/feature/roleA.ts",
      "src/feature/roleB.ts",
    ]);
    expect(cluster.members.find((m) => m.file === "src/feature/host.ts")?.isHost).toBe(true);
  });

  it("follows a chain (satellite of a satellite) into the same connected component", () => {
    const sources = [
      { file: "src/feat/host.ts", code: `import { mid } from "./mid";\nexport const h = mid;\n` },
      {
        file: "src/feat/mid.ts",
        code: `import { leaf } from "./leaf";\nexport const mid = leaf;\n`,
      },
      { file: "src/feat/leaf.ts", code: `export const leaf = 1;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].fileCount).toBe(3);
    expect(clusters[0].host).toBe("src/feat/host.ts");
  });
});

describe("detectFragmentationCandidates — exclusions", () => {
  it("does not flag a file imported by two different consumers (truly shared)", () => {
    const sources = [
      { file: "src/feat/a.ts", code: `import { u } from "./util";\nexport const a = u;\n` },
      { file: "src/feat/b.ts", code: `import { u } from "./util";\nexport const b = u;\n` },
      { file: "src/feat/util.ts", code: `export const u = 1;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(0);
  });

  it("ignores a satellite whose only importer is in a deeper directory (consumer not a host)", () => {
    const sources = [
      {
        file: "src/feat/deep/child.ts",
        code: `import { p } from "../../parent";\nexport const c = p;\n`,
      },
      { file: "src/feat/parent.ts", code: `export const p = 1;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(0);
  });

  it("does not treat a large file as a satellite", () => {
    const sources = [
      { file: "src/feat/host.ts", code: `import { big } from "./big";\nexport const h = big;\n` },
      { file: "src/feat/big.ts", code: `${small(120)}\nexport const big = 1;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(0);
  });

  it("excludes test/generated paths from the graph", () => {
    const sources = [
      {
        file: "src/feat/host.test.ts",
        code: `import { a } from "./roleA";\nexport const h = a;\n`,
      },
      { file: "src/feat/roleA.ts", code: `export const a = 1;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(0);
  });
});

describe("detectFragmentationCandidates — ranking", () => {
  it("ranks the cluster with more satellites first", () => {
    const sources = [
      {
        file: "src/big/host.ts",
        code: `import { a } from "./a";\nimport { b } from "./b";\nimport { c } from "./c";\nexport const h = a + b + c;\n`,
      },
      { file: "src/big/a.ts", code: `export const a = 1;\n` },
      { file: "src/big/b.ts", code: `export const b = 2;\n` },
      { file: "src/big/c.ts", code: `export const c = 3;\n` },
      { file: "src/sml/host.ts", code: `import { d } from "./d";\nexport const h = d;\n` },
      { file: "src/sml/d.ts", code: `export const d = 4;\n` },
    ];
    const { clusters } = detectFragmentationCandidatesFromSources(sources);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].host).toBe("src/big/host.ts");
    expect(clusters[0].satelliteCount).toBe(3);
  });
});
