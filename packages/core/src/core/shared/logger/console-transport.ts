/**
 * Console transport for Rejelly Logger.
 */

import type { LogEntry } from "./impl";
import { LogLevel } from "./impl";

type LogLevelLabel = "debug" | "info" | "warning" | "error";

function getLevelLabel(level: LogLevel): LogLevelLabel {
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
 * Transport that writes log entries to console (debug/info/warn/error).
 */
export function defaultConsoleTransport(entry: LogEntry): void {
  const label = getLevelLabel(entry.level);
  const prefix = `[Rejelly ${label}]`;
  const time = new Date(entry.timestamp).toISOString().split("T")[1].slice(0, -1);
  const formattedPrefix = `${prefix} ${time}`;

  switch (entry.level) {
    case LogLevel.DEBUG:
      console.debug(formattedPrefix, entry.message, ...entry.args);
      break;
    case LogLevel.INFO:
      console.info(formattedPrefix, entry.message, ...entry.args);
      break;
    case LogLevel.WARN:
      console.warn(formattedPrefix, entry.message, ...entry.args);
      break;
    case LogLevel.ERROR:
      console.error(formattedPrefix, entry.message, ...entry.args);
      break;
  }
}
