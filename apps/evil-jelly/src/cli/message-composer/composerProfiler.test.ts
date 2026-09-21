import { describe, expect, it } from "vitest";
import {
  COMPOSER_PROFILE_BURST_IDLE_MS,
  COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS,
  createComposerProfiler,
} from "./composerProfiler";

describe("composer profiler", () => {
  it("reports input cadence, commit latency, batching, and pending input for a live burst", () => {
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

    expect(profiler.snapshot()).toMatchObject({
      state: "live",
      durationMs: 80,
      idleMs: 0,
      idleCapped: false,
      inputCount: 3,
      commitCount: 1,
      pendingCount: 1,
      textLength: 4,
      rowCount: 1,
      repeatDelayMs: 30,
      steadyInputGapMs: { p50: 50, p95: 50, max: 50 },
      inputToCommitMs: { p50: 20, p95: 50, max: 50 },
      batchSize: { p95: 2, max: 2 },
      stallCount: 0,
    });
  });

  it("retains the last completed burst after the idle threshold", () => {
    let now = 0;
    const profiler = createComposerProfiler(() => now);

    profiler.recordLeftInput(2);
    now = 10;
    profiler.recordCommit(1, 2, 1);
    now = COMPOSER_PROFILE_BURST_IDLE_MS;

    expect(profiler.snapshot()).toMatchObject({
      state: "complete",
      inputCount: 1,
      commitCount: 1,
      pendingCount: 0,
      idleMs: COMPOSER_PROFILE_BURST_IDLE_MS,
    });

    now = COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS - 1;
    expect(profiler.snapshot()).toMatchObject({
      state: "complete",
      inputCount: 1,
      commitCount: 1,
      idleMs: COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS - 1,
      idleCapped: false,
    });
  });

  it("retains a completed burst but freezes its idle age after ten seconds", () => {
    let now = 0;
    const profiler = createComposerProfiler(() => now);

    profiler.recordLeftInput(2);
    now = 10;
    profiler.recordCommit(1, 2, 1);
    now = COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS;
    const capped = profiler.snapshot();

    expect(capped).toMatchObject({
      state: "complete",
      inputCount: 1,
      commitCount: 1,
      idleMs: COMPOSER_PROFILE_IDLE_DISPLAY_LIMIT_MS,
      idleCapped: true,
    });

    now = 60_000;
    expect(profiler.snapshot()).toBe(capped);
  });

  it("starts a fresh burst when input resumes after an idle interval", () => {
    let now = 0;
    const profiler = createComposerProfiler(() => now);

    profiler.recordLeftInput(3);
    now = 10;
    profiler.recordCommit(2, 3, 1);
    now = 1_000;
    profiler.recordLeftInput(2);

    expect(profiler.snapshot()).toMatchObject({
      state: "live",
      durationMs: 0,
      inputCount: 1,
      commitCount: 0,
      pendingCount: 1,
    });
  });

  it("does not record left input at the start of the buffer", () => {
    const profiler = createComposerProfiler(() => 0);
    profiler.recordLeftInput(0);

    expect(profiler.snapshot()).toMatchObject({
      state: "waiting",
      idleCapped: false,
      inputCount: 0,
      pendingCount: 0,
    });
  });
});
