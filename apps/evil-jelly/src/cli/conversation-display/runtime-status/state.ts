import type { RuntimePhase } from "../../../shared/host/presentationBindings";

/** The status-line state: current activity, stall anchor, and whole-turn timer. */
export interface RuntimeStatus {
  detail: string;
  phase: RuntimePhase;
  phaseSince: number;
  turnStartedAt: number | null;
  /** Completed reconnect waits excluded from the visible active-work timer. */
  workPausedMs: number;
  /** Start of the current reconnect wait, while active. */
  workPausedAt: number | null;
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
    workPausedMs: 0,
    workPausedAt: null,
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
  return transitionRuntimePhase(runtime, hasRunningTools ? "tool" : "working", detail, now);
}

export function transitionRuntimePhase(
  runtime: RuntimeStatus,
  phase: RuntimePhase,
  detail?: string,
  now = Date.now(),
): RuntimeStatus {
  if (phase === runtime.phase) {
    if (detail === undefined || detail === runtime.detail) return runtime;
    // A reconnecting detail change denotes the next physical attempt. Rebase only its timer while
    // preserving workPausedAt, which owns the whole outage pause.
    return phase === "reconnecting"
      ? { ...runtime, detail, phaseSince: now }
      : { ...runtime, detail };
  }
  const enteringReconnect = phase === "reconnecting";
  const leavingReconnect = runtime.phase === "reconnecting";
  const completedPauseMs =
    leavingReconnect && runtime.workPausedAt !== null ? Math.max(0, now - runtime.workPausedAt) : 0;
  return {
    ...runtime,
    phase,
    phaseSince: now,
    workPausedMs: runtime.workPausedMs + completedPauseMs,
    workPausedAt: enteringReconnect ? now : null,
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

/** Visible active-work duration, excluding time parked in reconnect backoff/request attempts. */
export function runtimeWorkElapsedMs(runtime: RuntimeStatus, now = Date.now()): number {
  const anchor = statusTimerAnchor(runtime.turnStartedAt, runtime.phaseSince);
  const activePauseMs = runtime.workPausedAt === null ? 0 : Math.max(0, now - runtime.workPausedAt);
  return Math.max(0, now - anchor - runtime.workPausedMs - activePauseMs);
}
