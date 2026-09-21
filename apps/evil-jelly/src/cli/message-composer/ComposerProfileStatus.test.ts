import { describe, expect, it } from "vitest";
import { formatComposerProfileStatus } from "./ComposerProfileStatus";

describe("composer profile status", () => {
  it("formats a fixed two-line human-readable summary", () => {
    expect(
      formatComposerProfileStatus({
        windowMs: 3_000,
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
      "Profile[left] · 3s · events 12 · chars 20 · rows 1 · input gap 31/41/92ms",
      "input→commit 6/18/71ms · commit gap 32/48/85ms · batch p95/max 2/3 · pending 2 · stalls 1",
    ]);
  });
});
