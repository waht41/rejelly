import { describe, expect, it } from "vitest";
import { formatComposerProfileStatus } from "./ComposerProfileStatus";

describe("composer profile status", () => {
  it("formats a live burst as a fixed two-line summary", () => {
    expect(
      formatComposerProfileStatus({
        state: "live",
        durationMs: 1_800,
        idleMs: 100,
        inputCount: 12,
        commitCount: 10,
        pendingCount: 2,
        textLength: 20,
        rowCount: 1,
        inputGapMs: { p50: 31.2, p95: 40.6, max: 92.1 },
        commitGapMs: { p50: 32, p95: 48, max: 85 },
        inputToCommitMs: { p50: 6, p95: 18, max: 71 },
        batchSize: { p95: 2, max: 3 },
        stallCount: 1,
      }),
    ).toEqual([
      "Profile[left] · live burst 1.8s · events 12 · chars 20 · rows 1 · input gap 31/41/92ms",
      "input→commit 6/18/71ms · commit gap 32/48/85ms · batch p95/max 2/3 · pending 2 · stalls 1",
    ]);
  });

  it("keeps a completed burst visible with its idle age", () => {
    const [firstLine] = formatComposerProfileStatus({
      state: "complete",
      durationMs: 1_800,
      idleMs: 4_200,
      inputCount: 54,
      commitCount: 50,
      pendingCount: 0,
      textLength: 20,
      rowCount: 1,
      stallCount: 2,
    });

    expect(firstLine).toContain("last burst 1.8s · ended 4.2s ago · events 54");
  });

  it("shows a stable waiting state before the first input", () => {
    expect(
      formatComposerProfileStatus({
        state: "waiting",
        durationMs: 0,
        idleMs: 0,
        inputCount: 0,
        commitCount: 0,
        pendingCount: 0,
        textLength: 10,
        rowCount: 1,
        stallCount: 0,
      }),
    ).toEqual([
      "Profile[left] · waiting for input · chars 10 · rows 1",
      "input gap —/—/—ms · input→commit —/—/—ms · batch p95/max —/— · pending 0",
    ]);
  });
});
