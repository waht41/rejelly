import { describe, expect, it } from "vitest";
import { createComposerProfiler } from "./composerProfiler";

describe("composer profiler", () => {
  it("reports input cadence, commit latency, batching, and pending input", () => {
    let now = 0;
    const profiler = createComposerProfiler(() => now);

    profiler.recordCommit(4, 4, 1);
    profiler.recordLeftInput(4);
    now = 30;
    profiler.recordLeftInput(3);
    now = 50;
    profiler.recordCommit(2, 4, 1);
    now = 80;
    profiler.recordLeftInput(2);

    const snapshot = profiler.snapshot(1_000);
    expect(snapshot).toMatchObject({
      inputCount: 3,
      commitCount: 1,
      pendingCount: 1,
      textLength: 4,
      rowCount: 1,
      inputGapMs: { p50: 30, p95: 50, max: 50 },
      inputToCommitMs: { p50: 20, p95: 50, max: 50 },
      batchSize: { p95: 2, max: 2 },
      stallCount: 0,
    });
  });

  it("keeps only samples in the requested rolling window", () => {
    let now = 0;
    const profiler = createComposerProfiler(() => now);

    profiler.recordLeftInput(2);
    now = 10;
    profiler.recordCommit(1, 2, 1);
    now = 4_000;

    expect(profiler.snapshot(3_000)).toMatchObject({
      inputCount: 0,
      commitCount: 0,
      pendingCount: 0,
    });
  });

  it("does not record left input at the start of the buffer", () => {
    const profiler = createComposerProfiler(() => 0);
    profiler.recordLeftInput(0);

    expect(profiler.snapshot()).toMatchObject({ inputCount: 0, pendingCount: 0 });
  });
});
