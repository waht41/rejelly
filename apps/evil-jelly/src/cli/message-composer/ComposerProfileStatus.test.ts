import { describe, expect, it } from "vitest";
import { formatComposerProfileStatus } from "./ComposerProfileStatus";

describe("composer profile status", () => {
  it("formats a live burst as a fixed three-line summary", () => {
    expect(
      formatComposerProfileStatus({
        state: "live",
        durationMs: 1_800,
        idleMs: 100,
        idleCapped: false,
        inputCount: 12,
        commitCount: 10,
        pendingCount: 2,
        textLength: 20,
        rowCount: 1,
        repeatDelayMs: 514,
        steadyInputGapMs: { p50: 31.2, p95: 40.6, max: 47.1 },
        steadyCommitGapMs: { p50: 32, p95: 48, max: 49 },
        inputToCommitMs: { p50: 6, p95: 18, max: 71 },
        commitToFrameMs: { p50: 4, p95: 28, max: 34 },
        steadyFrameGapMs: { p50: 34, p95: 35, max: 36 },
        frameBatchSize: { p95: 2, max: 2 },
        inkRenderTimeMs: { p50: 1, p95: 2, max: 3 },
        eventLoopDelayMs: { p50: 1, p95: 2, max: 5 },
        batchSize: { p95: 2, max: 3 },
        stallCount: 1,
      }),
    ).toEqual([
      "Profile[left] · live burst 1.8s · events 12 · chars 20 · rows 1",
      "input: repeat 514ms · steady 31/41/47ms · input→commit 6/18/71ms · loop lag 1/2/5ms",
      "frame: commit→frame 4/28/34ms · steady gap 34/35/36ms · batch p95/max 2/2 · render 1/2/3ms · pending 2",
    ]);
  });

  it("keeps a completed burst visible with its idle age", () => {
    const [firstLine] = formatComposerProfileStatus({
      state: "complete",
      durationMs: 1_800,
      idleMs: 4_200,
      idleCapped: false,
      inputCount: 54,
      commitCount: 50,
      pendingCount: 0,
      textLength: 20,
      rowCount: 1,
      stallCount: 2,
    });

    expect(firstLine).toContain("last burst 1.8s · ended 4.2s ago · events 54");
  });

  it("caps the displayed idle age after ten seconds", () => {
    const [firstLine] = formatComposerProfileStatus({
      state: "complete",
      durationMs: 1_800,
      idleMs: 10_000,
      idleCapped: true,
      inputCount: 54,
      commitCount: 50,
      pendingCount: 0,
      textLength: 20,
      rowCount: 1,
      stallCount: 2,
    });

    expect(firstLine).toContain("last burst 1.8s · ended >10s ago · events 54");
  });

  it("shows a stable waiting state before the first input", () => {
    expect(
      formatComposerProfileStatus({
        state: "waiting",
        durationMs: 0,
        idleMs: 0,
        idleCapped: false,
        inputCount: 0,
        commitCount: 0,
        pendingCount: 0,
        textLength: 10,
        rowCount: 1,
        stallCount: 0,
      }),
    ).toEqual([
      "Profile[left] · waiting for input · chars 10 · rows 1",
      "input: repeat —ms · steady —/—/—ms · input→commit —/—/—ms · loop lag —/—/—ms",
      "frame: commit→frame —/—/—ms · steady gap —/—/—ms · batch p95/max —/— · render —/—/—ms",
    ]);
  });
});
