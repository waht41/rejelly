import { describe, expect, it } from "vitest";
import {
  beginRuntimeTurn,
  finishRuntimeToolBatch,
  idleRuntime,
  resumeRuntimeWork,
  transitionRuntimePhase,
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
