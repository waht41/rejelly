/**
 * Node.js shutdown helper for batch exporters.
 *
 * Registers SIGINT / SIGTERM / beforeExit (and optionally uncaughtException /
 * unhandledRejection). Call from registerShutdown — not used automatically by the core engine.
 */

import type { ExporterRegisterShutdown } from "./types";

export interface RegisterNodeShutdownOptions {
  /**
   * Force exit if flush does not finish within this many ms (default: 3000).
   */
  shutdownTimeout?: number;
  /**
   * Listen for uncaughtException / unhandledRejection and flush before exit.
   * May conflict with other global error handlers (e.g. Sentry). Default: false.
   */
  catchGlobalErrors?: boolean;
}

/**
 * Returns a registerShutdown callback suitable for ExporterConfig / ReviewOptions / OTLPOptions.
 *
 * No-ops when `process` or `process.on` is unavailable (e.g. browsers, some edge runtimes).
 */
export function registerNodeShutdown(
  options?: RegisterNodeShutdownOptions,
): ExporterRegisterShutdown {
  return (forceFlush: () => Promise<void>) => {
    if (typeof process === "undefined" || !process.on) {
      console.warn(
        "[Exporter] registerNodeShutdown: process.on is unavailable; SIGINT/SIGTERM hooks were not registered. Call disable() or bind flush in your host (e.g. ctx.waitUntil(disable())).",
      );
      return;
    }

    const shutdownTimeout = options?.shutdownTimeout ?? 3000;
    const catchGlobalErrors = options?.catchGlobalErrors ?? false;

    let isExiting = false;

    const handleExit = (signal: string, exitCode: number) => {
      if (isExiting) return;
      isExiting = true;

      console.log(`[Exporter] Received ${signal}, flushing batch...`);

      const forceExitTimer = setTimeout(() => {
        console.error(`[Exporter] Flush timeout after ${shutdownTimeout}ms, force exiting...`);
        process.exit(exitCode);
      }, shutdownTimeout);
      if (forceExitTimer.unref) forceExitTimer.unref();

      forceFlush()
        .then(() => {
          clearTimeout(forceExitTimer);
          console.log("[Exporter] Flush completed");
          process.exit(exitCode);
        })
        .catch((err) => {
          clearTimeout(forceExitTimer);
          console.error("[Exporter] Flush failed:", err);
          process.exit(exitCode);
        });
    };

    const handleSIGINT = () => handleExit("SIGINT", 0);
    const handleSIGTERM = () => handleExit("SIGTERM", 0);
    const handleBeforeExit = () => {
      forceFlush().catch(console.error);
    };

    process.on("SIGINT", handleSIGINT);
    process.on("SIGTERM", handleSIGTERM);
    process.on("beforeExit", handleBeforeExit);

    let handleUncaughtException: ((err: Error) => void) | null = null;
    let handleUnhandledRejection: ((reason: unknown) => void) | null = null;

    if (catchGlobalErrors) {
      handleUncaughtException = (err: Error) => {
        console.error("[Exporter] Uncaught exception:", err);
        handleExit("uncaughtException", 1);
      };
      handleUnhandledRejection = (reason: unknown) => {
        console.error("[Exporter] Unhandled rejection:", reason);
        handleExit("unhandledRejection", 1);
      };

      process.on("uncaughtException", handleUncaughtException);
      process.on("unhandledRejection", handleUnhandledRejection);
    }

    return () => {
      process.off("SIGINT", handleSIGINT);
      process.off("SIGTERM", handleSIGTERM);
      process.off("beforeExit", handleBeforeExit);
      if (handleUncaughtException) {
        process.off("uncaughtException", handleUncaughtException);
      }
      if (handleUnhandledRejection) {
        process.off("unhandledRejection", handleUnhandledRejection);
      }
    };
  };
}
