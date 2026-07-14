/**
 * Framework-log → sys:log bridge (auto-registered).
 *
 * Registers `eventTransport` on the internal logger the first time an agent context is created,
 * so framework logger records fold onto their span as `sys:log` events for ANY traced run — a
 * bare `createAgent()()` (which self-roots) as much as a `runWith(...)` wrapper.
 *
 * Registered once per realm and never removed: `eventTransport` self-gates on the current trace
 * context, so it is inert (a cheap no-op) when logging happens outside a run. Making it permanent
 * avoids per-run register/unregister bookkeeping and refcounting across concurrent roots.
 *
 * The registration is a runtime call (not an import-time side effect), so the logger core stays a
 * dependency leaf — the observability layer injects the bridge into it, never the other way around.
 */

import { loggerControl } from "../shared/logger/instance";
import { eventTransport } from "./event-transport";

/**
 * Versioned global guard, mirroring the logger / event-bus / context-store singletons (each keyed
 * on its own `Symbol.for("@rejelly/core/<name>/v1")`). Keying the "already registered" flag on
 * globalThis — rather
 * than a module-local boolean — makes the bridge robust to the same hazards those singletons handle:
 *
 * - HMR: module re-evaluation resets a local flag but not globalThis, so we neither churn nor
 *   silently re-register after an explicit `removeTransport("sys-log-events")` opt-out.
 * - Duplicate package copies (same major): all copies share this flag AND the underlying logger,
 *   event bus and context store, so exactly one copy registers and it routes correctly.
 *
 * Distinct majors intentionally use distinct symbols, so v1 and v2 keep separate bridges/loggers.
 */
const BRIDGE_SYMBOL = Symbol.for("@rejelly/core/sys-log-bridge/v1");

/** Idempotently register the framework-log → sys:log bridge. Safe to call on every context creation. */
export function ensureSysLogBridge(): void {
  const globalStore = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;
  if (globalStore[BRIDGE_SYMBOL]) return;
  globalStore[BRIDGE_SYMBOL] = true;
  loggerControl.registerTransport("sys-log-events", eventTransport);
}
