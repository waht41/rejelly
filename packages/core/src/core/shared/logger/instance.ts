/**
 * Lazy singleton logger instance and public API.
 */

import { defaultConsoleTransport } from "./console-transport";
import type { LogTransport } from "./impl";
import { LoggerImpl, LogLevel } from "./impl";

// === Lazy singleton ===

/**
 * Versioned global key for cross-package singleton sharing.
 *
 * Keep the major version in the symbol name so incompatible core majors
 * can coexist in one process without corrupting each other's logger.
 */
const LOGGER_INSTANCE_SYMBOL = Symbol.for("@rejelly/core/logger-instance/v1");

function getInstance(): LoggerImpl {
  const globalStore = globalThis as typeof globalThis & Record<symbol, LoggerImpl | undefined>;

  if (!globalStore[LOGGER_INSTANCE_SYMBOL]) {
    const instance = new LoggerImpl();
    instance.registerTransport("default-console", defaultConsoleTransport);
    globalStore[LOGGER_INSTANCE_SYMBOL] = instance;
  }
  return globalStore[LOGGER_INSTANCE_SYMBOL] as LoggerImpl;
}

// === Public API ===
//
// The facade is split by capability, both backed by the same singleton:
// - `logger`        — the EMIT surface (debug/info/warn/error). Framework-internal only:
//                     "framework logs" (`sys:log`) must originate from the framework, never from
//                     application code. Not re-exported from the package's public surface, so app
//                     code cannot pollute the framework log/sys:log stream.
// - `loggerControl` — the CONTROL surface (level + transport management). App-facing, re-exported
//                     from `@rejelly/core/debugger`; it carries no emit methods.

/**
 * Emit surface — framework-internal logging.
 *
 * Only framework code should call these. Application code that needs its own logging should use
 * its own logger; emitting through this facade would surface as framework `sys:log` diagnostics.
 * Not exported from the package's public surface (see `loggerControl` for the app-facing API).
 */
export const logger = {
  debug: (msg: string, ...args: any[]) => getInstance().log(LogLevel.DEBUG, msg, args),
  info: (msg: string, ...args: any[]) => getInstance().log(LogLevel.INFO, msg, args),
  warn: (msg: string, ...args: any[]) => getInstance().log(LogLevel.WARN, msg, args),
  error: (msg: string, ...args: any[]) => getInstance().log(LogLevel.ERROR, msg, args),
};

/**
 * Control surface — runtime level & transport management (no emit).
 *
 * This is the app-facing logger API (re-exported from `@rejelly/core/debugger`). Use it to tune
 * verbosity or attach custom sinks.
 *
 * Notes:
 * - The logger registers a `default-console` transport by default. On the first traced run the
 *   framework also registers a `sys-log-events` transport that folds records onto their span
 *   (see core `sys-log-bridge`); it is inert outside a run.
 * - `setGlobalLevel` is the master verbosity switch (e.g. `WARN` in prod, `INFO`/`DEBUG` in dev).
 * - You can disable a transport by name, e.g. `loggerControl.removeTransport("default-console")`
 *   or `loggerControl.removeTransport("sys-log-events")` to opt out of span logs.
 */
export const loggerControl = {
  setGlobalLevel: (level: LogLevel) => getInstance().setGlobalLevel(level),
  registerTransport: (name: string, handler: LogTransport, level?: LogLevel) =>
    getInstance().registerTransport(name, handler, level),
  setTransportLevel: (name: string, level: LogLevel) =>
    getInstance().setTransportLevel(name, level),
  removeTransport: (name: string) => getInstance().removeTransport(name),
};
