/**
 * Context-aware logger transport for emitting observability events.
 */

import { getCurrentContextSafe } from "../context/accessor";
import type { SysLogEvent } from "../domain/events";
import type { TraceContext } from "../domain/trace";
import type { LogEntry } from "../shared/logger/impl";
import { LogLevel } from "../shared/logger/impl";
import { createEmitter } from "./telemetry";

function getLevelLabel(level: LogLevel): SysLogEvent["level"] {
  switch (level) {
    case LogLevel.DEBUG:
      return "debug";
    case LogLevel.INFO:
      return "info";
    case LogLevel.WARN:
      return "warning";
    case LogLevel.ERROR:
      return "error";
    default:
      return "info";
  }
}

/**
 * Reentrancy guard. eventTransport is registered as a logger transport, so emitting a sys:log can
 * make the event bus log again during dispatch (e.g. event-bus.ts logs "[Event Bus] callback error"
 * inside emit when a subscriber throws). That log would re-enter eventTransport -> emit -> ...
 * unbounded recursion.
 *
 * Contract: a logger transport must not emit framework events while an emit dispatch is already in
 * progress. Event-bus dispatch is synchronous, so a module-level flag scoped around the emit call
 * breaks the cycle regardless of the log message — unlike the old "[Event Bus]" / "Maximum call
 * stack" substring blacklist, which silently depended on the bus's exact log prefixes and missed
 * subscriber-side logging recursion.
 */
let emitting = false;

/**
 * Transport that emits each log entry as sys:log event via createEmitter.
 */
export function eventTransport(entry: LogEntry): void {
  if (emitting) {
    console.error(
      "[Rejelly] event dropped to avoid emit reentrancy: ",
      entry.message,
      ...entry.args,
    );
    return;
  }

  const ctx = getCurrentContextSafe();
  const { traceId = "", spanId = "", parentSpanId = "" } = ctx?.trace || {};
  // sys:log folds onto its own spanId as a span event (= the span it was logged in), so a
  // missing spanId has no span to correlate to. Fabricating one (generateSpanId) would point
  // at a span that never exists -> guaranteed OTLP orphan and a false correlation for other
  // consumers (DevTool reads trace.spanId). Bail like the no-traceId case instead.
  //
  // The bridge is permanently registered, so framework logs emitted outside any run (e.g. during
  // setup, or runWith's own pre-context warnings) routinely land here — that is expected, not an
  // error, so stay silent. The log still reaches the console transport; it just has no span.
  if (!traceId || !spanId) return;

  if (!ctx?.eventBus?.emit) {
    console.warn("[Rejelly] event bus not found: ", entry.message, ...entry.args);
    return;
  }

  const trace: TraceContext = {
    traceId,
    spanId,
    parentSpanId,
  };

  const emitter = createEmitter(ctx?.eventBus?.emit, trace, ctx?.agentId);
  emitting = true;
  try {
    emitter.sysLog({
      level: getLevelLabel(entry.level),
      message: entry.message,
      args: entry.args,
    });
  } finally {
    emitting = false;
  }
}
