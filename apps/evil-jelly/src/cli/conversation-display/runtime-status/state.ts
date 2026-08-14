import type { RuntimePhase } from "../../../shared/host/presentationBindings";

/** The status-line state: current activity, stall anchor, and whole-turn timer. */
export interface RuntimeStatus {
  detail: string;
  phase: RuntimePhase;
  phaseSince: number;
  turnStartedAt: number | null;
  lastOutputAt: number;
}

export interface RuntimeStatusState {
  runtime: RuntimeStatus;
}

export function idleRuntime(now = Date.now()): RuntimeStatus {
  return {
    detail: "Ready",
    phase: "idle",
    phaseSince: now,
    turnStartedAt: null,
    lastOutputAt: now,
  };
}

export function withRuntimeDetail(runtime: RuntimeStatus, detail: string): RuntimeStatus {
  return { ...runtime, detail };
}

/** Anchor the whole-turn timer once; steers and later phase transitions must not restart it. */
export function beginRuntimeTurn(runtime: RuntimeStatus, now = Date.now()): RuntimeStatus {
  return runtime.turnStartedAt === null ? { ...runtime, turnStartedAt: now } : runtime;
}

export function resumeRuntimeWork(
  runtime: RuntimeStatus,
  hasRunningTools: boolean,
  detail?: string,
  now = Date.now(),
): RuntimeStatus {
  return {
    ...runtime,
    phase: hasRunningTools ? "tool" : "working",
    phaseSince: now,
    ...(detail === undefined ? {} : { detail }),
  };
}

export function transitionRuntimePhase(
  runtime: RuntimeStatus,
  phase: RuntimePhase,
  detail?: string,
  now = Date.now(),
): RuntimeStatus {
  if (phase === runtime.phase) {
    return detail === undefined || detail === runtime.detail ? runtime : { ...runtime, detail };
  }
  return {
    ...runtime,
    phase,
    phaseSince: now,
    ...(detail === undefined ? {} : { detail }),
  };
}

export function recordRuntimeOutput(runtime: RuntimeStatus, now = Date.now()): RuntimeStatus {
  return { ...runtime, lastOutputAt: now };
}

export function finishRuntimeToolBatch(
  runtime: RuntimeStatus,
  hasRunningTools: boolean,
  now = Date.now(),
): RuntimeStatus {
  return runtime.phase === "tool" && !hasRunningTools
    ? { ...runtime, phase: "working", phaseSince: now }
    : runtime;
}

export function isRuntimeActive(phase: RuntimePhase, streamBuffer: string): boolean {
  return streamBuffer.length > 0 || (phase !== "idle" && phase !== "awaiting_user");
}

/** Whole-turn anchor when available; phase anchor for maintenance work outside a turn. */
export function statusTimerAnchor(turnStartedAt: number | null, phaseSince: number): number {
  return turnStartedAt ?? phaseSince;
}
