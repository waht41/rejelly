/**
 * Catcher (抓取器)
 *
 * Runs an Agent in an isolated sandbox (custom EventBus), swallows expected
 * business errors, and returns a clean array of TraceEvents for export or
 * restoreSnapshot. Used by mock/scenario generators to feed DevTool.
 */

import { createEventBus, type RunWithOptions, runWith, type TraceEvent } from "@rejelly/core";

export interface CatchTraceOptions<P = unknown> {
  /** Enable snapshot (journal, dumpSnapshot). Default true for scenario generation. */
  enableSnapshot?: boolean;
  /** Initial props passed to the run function (if it accepts props). */
  initialProps?: P;
  /** Distributed tracing: traceId, parentSpanId, attributes (see core.md runWith). */
  trace?: RunWithOptions<P>["trace"];
}

export interface CatchTraceResult<T = unknown> {
  /** All trace events emitted during the run (including runWith:start/end). */
  events: TraceEvent[];
  /** Resolved value when run completed successfully. */
  result?: T;
  /** Error thrown by the run (we swallow it so the script can continue). */
  error?: unknown;
}

/**
 * Run a thunk inside an isolated EventBus, collect all TraceEvents, and swallow
 * errors. Use for generating scenario .jsonl files or feeding restoreSnapshot.
 *
 * @param run - Async function to run (e.g. () => Agent(props) or (props) => Agent(props))
 * @param options - enableSnapshot, initialProps (passed to run when run accepts one argument)
 * @returns { events, result?, error? } — events are always populated; result or error set depending on outcome
 */
export async function catchTraceEvents<T, P = unknown>(
  run: (props?: P) => Promise<T>,
  options: CatchTraceOptions<P> = {},
): Promise<CatchTraceResult<T>> {
  const { enableSnapshot = true, initialProps, trace } = options;
  const eventBus = createEventBus();
  const events: TraceEvent[] = [];

  eventBus.subscribe("*", (event) => {
    events.push(event);
  });

  let result: T | undefined;
  let error: unknown;

  try {
    result = (await runWith(
      async (props: P) => {
        return await run(props);
      },
      {
        eventBus,
        enableSnapshot,
        initialProps,
        trace,
      },
    )) as T;
    return { events, result };
  } catch (e) {
    error = e;
    return { events, error };
  }
}
