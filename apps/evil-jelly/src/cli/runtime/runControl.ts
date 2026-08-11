/**
 * Run-scoped abort bridge for Ctrl+C.
 *
 * Distinct from shared `runtimeControl` (task-scoped, Esc / `/stop`, which aborts
 * only the active sub-agent and lets the run continue): this aborts the whole
 * `runWith` run. Aborting the run-level controller delivers the cancel signal to
 * the entire agent tree + teardown, so in-flight model/tool calls cancel and the
 * trace closes cleanly before the process exits.
 */

let runAbort: ((reason: string) => void) | null = null;

/** Register the active run's abort. Returns an unregister fn (call in the run's finally). */
export function registerRunAbort(fn: (reason: string) => void): () => void {
  runAbort = fn;
  return () => {
    if (runAbort === fn) {
      runAbort = null;
    }
  };
}

/** Abort the active run. Returns false when no run is registered (nothing to abort). */
export function requestRunAbort(reason: string): boolean {
  if (!runAbort) {
    return false;
  }
  runAbort(reason);
  return true;
}
