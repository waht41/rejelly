import { type CustomSpanEndEvent, createEventBus, EVENTS, runWith } from "@rejelly/core";
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
    const eventBus = createEventBus();
    const spanEnds: CustomSpanEndEvent[] = [];
    eventBus.subscribe(EVENTS.CUSTOM_SPAN_END, (event) => spanEnds.push(event));
    const evaluation = runWith(
      () =>
        evaluatePreparedSeeds(
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
        ),
      { eventBus },
    );

    await vi.advanceTimersByTimeAsync(250);
    const findings = await evaluation;

    expect(findings).toHaveLength(2);
    expect(findings[0]?.verdict).toEqual(verdict);
    expect(findings[1]?.error).toBe("Evaluator timed out after 250ms");
    expect(pendingSignal?.aborted).toBe(true);
    expect(settled).toHaveLength(2);
    expect(settled.map((finding) => finding.seed.id).sort()).toEqual(["fast", "hung"]);

    const hungSpan = spanEnds.find(
      (event) => event.trace.attributes?.["evil_jelly.audit.candidate_id"] === "hung",
    );
    expect(hungSpan?.name).toBe("audit.evaluate_seed");
    expect(hungSpan?.trace.attributes).toMatchObject({
      "evil_jelly.audit.family": "clone",
      "evil_jelly.audit.fingerprint": "fingerprint-hung",
      "evil_jelly.audit.evaluator_index": 2,
      "evil_jelly.audit.status": "timeout",
      "evil_jelly.audit.settled": true,
      "evil_jelly.audit.error": "Evaluator timed out after 250ms",
    });
  });
});
