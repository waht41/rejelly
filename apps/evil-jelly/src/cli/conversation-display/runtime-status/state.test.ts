import { describe, expect, it } from "vitest";
import {
  beginRuntimeTurn,
  finishRuntimeToolBatch,
  idleRuntime,
  resumeRuntimeWork,
  runtimeWorkElapsedMs,
  transitionRuntimePhase,
  updateRuntimeReconnect,
} from "./state";

describe("runtime status state", () => {
  it("does not restart an unchanged phase", () => {
    const runtime = transitionRuntimePhase(idleRuntime(1), "connecting", undefined, 10);
    expect(transitionRuntimePhase(runtime, "connecting", undefined, 20)).toBe(runtime);
  });

  it("anchors a turn once across later calls", () => {
    const runtime = beginRuntimeTurn(idleRuntime(1), 10);
    expect(beginRuntimeTurn(runtime, 20)).toBe(runtime);
  });

  it("pauses active-work time while reconnecting and resumes without a jump", () => {
    const started = beginRuntimeTurn(idleRuntime(0), 1_000);
    const reconnecting = transitionRuntimePhase(started, "reconnecting", undefined, 6_000);

    expect(runtimeWorkElapsedMs(reconnecting, 16_000)).toBe(5_000);

    const resumed = transitionRuntimePhase(reconnecting, "thinking", undefined, 16_000);
    expect(runtimeWorkElapsedMs(resumed, 18_000)).toBe(7_000);
  });

  it("restarts only the retry substage timer while preserving the whole outage pause", () => {
    const started = beginRuntimeTurn(idleRuntime(0), 1_000);
    const backoff = updateRuntimeReconnect(
      started,
      {
        stage: "backoff",
        kind: "connection",
        attempt: 2,
        errorCode: "connection_error",
        stageStartedAt: 6_000,
        retryAt: 16_000,
      },
      6_000,
    );
    const attempt = updateRuntimeReconnect(
      backoff,
      {
        stage: "attempt",
        kind: "connection",
        attempt: 2,
        errorCode: "connection_error",
        stageStartedAt: 16_000,
      },
      16_000,
    );

    expect(attempt).toMatchObject({
      phaseSince: 16_000,
      workPausedAt: 6_000,
      workPausedMs: 0,
      reconnect: { stage: "attempt", attempt: 2 },
    });
    expect(runtimeWorkElapsedMs(attempt, 20_000)).toBe(5_000);
  });

  it("clears reconnect progress when normal work resumes", () => {
    const reconnecting = updateRuntimeReconnect(idleRuntime(0), {
      stage: "attempt",
      kind: "transient",
      attempt: 2,
      errorCode: "timeout",
      stageStartedAt: 10,
    });

    expect(transitionRuntimePhase(reconnecting, "thinking", undefined, 20).reconnect).toBeNull();
  });

  it("resumes in the phase matching live tool state", () => {
    const runtime = idleRuntime(1);
    expect(resumeRuntimeWork(runtime, true, undefined, 10).phase).toBe("tool");
    expect(resumeRuntimeWork(runtime, false, undefined, 10).phase).toBe("working");
  });

  it("leaves tool phase when its final running tool completes", () => {
    const runtime = transitionRuntimePhase(idleRuntime(1), "tool", undefined, 10);
    expect(finishRuntimeToolBatch(runtime, false, 20)).toMatchObject({
      phase: "working",
      phaseSince: 20,
    });
  });
});
