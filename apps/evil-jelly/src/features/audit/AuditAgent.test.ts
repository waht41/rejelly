import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatePreparedSeeds } from "./AuditAgent";
import type { AuditFinding, PreparedSeed, SeedVerdict } from "./types";

const verdict: SeedVerdict = {
  isActionable: false,
  severity: "low",
  category: "leave-as-is",
  summary: "No change needed",
  rationale: "The candidate is acceptable.",
  proposal: "",
};

function prepared(id: string, evaluate: PreparedSeed["evaluate"]): PreparedSeed {
  return {
    seed: {
      kind: "clone",
      id,
      locations: [{ file: `src/${id}.ts`, startLine: 1, endLine: 1, lines: 1 }],
      fileCount: 1,
      weight: 1,
      label: id,
    },
    identity: {
      id: `clone:${id}`,
      kind: "clone",
      fingerprint: `fingerprint-${id}`,
      contentHash: `content-${id}`,
    },
    evaluate,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluatePreparedSeeds", () => {
  it("aborts, checkpoints, and settles a permanently pending evaluator", async () => {
    vi.useFakeTimers();
    let pendingSignal: AbortSignal | undefined;
    const settled: AuditFinding[] = [];
    const evaluation = evaluatePreparedSeeds(
      [
        prepared("fast", async () => verdict),
        prepared("hung", async (signal) => {
          pendingSignal = signal;
          return await new Promise(() => undefined);
        }),
      ],
      "Code duplication",
      2,
      250,
      vi.fn(),
      async (finding) => {
        settled.push(finding);
      },
    );

    await vi.advanceTimersByTimeAsync(250);
    const findings = await evaluation;

    expect(findings).toHaveLength(2);
    expect(findings[0]?.verdict).toEqual(verdict);
    expect(findings[1]?.error).toBe("Evaluator timed out after 250ms");
    expect(pendingSignal?.aborted).toBe(true);
    expect(settled).toHaveLength(2);
    expect(settled.map((finding) => finding.seed.id).sort()).toEqual(["fast", "hung"]);
  });
});
