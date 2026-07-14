/**
 * Rejelly Internal Logger
 *
 * Design:
 * - Zero side-effects on import.
 * - Lazy instantiation: The Logger class is only instantiated upon the first log call.
 * - Multiple transports, each with its own level filter; globalLevel as master switch.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 99,
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  args: any[];
  timestamp: number;
}

export type LogTransport = (entry: LogEntry) => void;

/**
 * Stored config for a single transport (name, handler, per-transport level).
 */
export interface TransportConfig {
  name: string;
  handler: LogTransport;
  level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
}

export class LoggerImpl {
  /** Master switch: skip any log below this level. */
  private globalLevel: LogLevel = LogLevel.INFO;
  private transports: Map<string, TransportConfig> = new Map();

  constructor(options: LoggerOptions = {}) {
    if (options.level !== undefined) this.globalLevel = options.level;
  }

  registerTransport(name: string, handler: LogTransport, level: LogLevel = LogLevel.INFO): void {
    this.transports.set(name, { name, handler, level });
  }

  setTransportLevel(name: string, level: LogLevel): void {
    const t = this.transports.get(name);
    if (t) t.level = level;
  }

  removeTransport(name: string): void {
    this.transports.delete(name);
  }

  setGlobalLevel(level: LogLevel): void {
    this.globalLevel = level;
  }

  log(level: LogLevel, message: string, args: any[]) {
    if (level < this.globalLevel) return;

    const entry: LogEntry = { level, message, args, timestamp: Date.now() };

    for (const t of this.transports.values()) {
      if (level >= t.level) {
        try {
          t.handler(entry);
        } catch (e) {
          console.error(`[Rejelly] Custom transport '${t.name}' failed:`, e);
        }
      }
    }
  }
}
