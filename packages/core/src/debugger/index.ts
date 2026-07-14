/**
 * Debugger Module
 *
 * Provides logging and observability tools:
 * - OTLP: Send traces to OTLP-compatible servers
 * - Review: Send traces to Rejelly Review Server in realtime mode
 *
 * @example
 * import { enableReview } from '@rejelly/core/debugger';
 *
 * const disable = enableReview({ endpoint: 'http://localhost:5789/api/v1/traces' });
 * await MyAgent({ topic: 'hello' });
 * await disable();
 */

// Logger CONTROL surface (level + transport management). The emit surface
// (debug/info/warn/error) stays framework-internal — see logger/instance.ts.
export type { LogEntry, LogTransport } from "../core/shared/logger/impl";
export { LogLevel } from "../core/shared/logger/impl";
export { loggerControl } from "../core/shared/logger/instance";
// Snapshot (state persistence & replay) - typically used with debugger/tooling
export { type DumpSnapshotOptions, dumpSnapshot } from "../core/snapshot/dump";
export { type RestoreOptions, restoreSnapshot } from "../core/snapshot/restore";
// Export OTLP exporter
export { enableOTLP } from "./open-telemetry";
// Export Review exporter
export { enableReview } from "./review";
// Node shutdown helper (IoC — core batch exporter does not attach process listeners itself;
// enableReview / enableOTLP default to this when registerShutdown is omitted)
export { type RegisterNodeShutdownOptions, registerNodeShutdown } from "./shutdown-node";

// Export logger config types
export type { ExporterRegisterShutdown, OTLPOptions, ReviewOptions } from "./types";
