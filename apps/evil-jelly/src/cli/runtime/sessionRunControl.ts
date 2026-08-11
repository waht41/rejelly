/**
 * Mid-session session-switch bridge.
 *
 * When the user types `/resume` during a live run, MainCliAgent resolves a target sessionId,
 * stashes it here, and ends the current run (no reborn) so its runWith — and thus its trace —
 * closes cleanly. The CLI's outer loop then reads the pending id and starts a fresh run segment
 * with its own traceId, keeping the "one trace per launch/resume segment" invariant.
 *
 * `/clear` uses the same boundary to start a new empty session instead of mutating the current
 * persisted session.
 */

let pendingResumeSessionId: string | null = null;
let pendingNewSession = false;
let pendingExit = false;

/** Queue a session to switch to once the current run ends. */
export function requestResume(sessionId: string): void {
  pendingResumeSessionId = sessionId;
  pendingNewSession = false;
  pendingExit = false;
}

/** Read and clear the pending resume target (consumed once by the outer loop). */
export function takePendingResume(): string | null {
  const value = pendingResumeSessionId;
  pendingResumeSessionId = null;
  return value;
}

/** Queue a new empty session once the current run ends. */
export function requestNewSession(): void {
  pendingResumeSessionId = null;
  pendingNewSession = true;
  pendingExit = false;
}

/** Read and clear the pending new-session request (consumed once by the outer loop). */
export function takePendingNewSession(): boolean {
  const value = pendingNewSession;
  pendingNewSession = false;
  return value;
}

/** Queue the interactive loop to exit once the current run unwinds. */
export function requestExit(): void {
  pendingResumeSessionId = null;
  pendingNewSession = false;
  pendingExit = true;
}

/** Read and clear the pending exit request (consumed once by the outer loop). */
export function takePendingExit(): boolean {
  const value = pendingExit;
  pendingExit = false;
  return value;
}
