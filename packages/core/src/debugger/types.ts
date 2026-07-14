/**
 * Debugger Types
 *
 * Configuration types for logging and debugging.
 */

import type { TraceEvent } from "../core/domain/events";
import type { EventBus } from "../core/observability/event-bus";

/**
 * Host-controlled shutdown: the core engine passes forceFlush; the host may return
 * a cleanup function run when the exporter is disabled. Cleanup may be async (e.g. I/O
 * or network during listener teardown).
 */
export type ExporterRegisterShutdown = (
  forceFlush: () => Promise<void>,
) => void | (() => void | Promise<void>);

/**
 * Export-boundary trace event conversion hook.
 *
 * Intended for event-level redaction or shaping before a remote exporter serializes the event.
 * May be async so applications can externalize multimodal payloads before export. Return the
 * same event family so exporter internals can keep their existing type narrowing.
 */
export type TraceEventConverter = <T extends TraceEvent>(event: T) => T | Promise<T>;

/**
 * OTLP traces exporter options
 */
export interface OTLPOptions {
  /** OTLP endpoint URL (e.g., 'http://localhost:4318/v1/traces') */
  endpoint: string;
  /** Custom event bus (optional, defaults to global) */
  eventBus?: EventBus;
  /** Service name for traces (default: 'rejelly') */
  serviceName?: string;
  /** Additional resource attributes */
  resourceAttributes?: Record<string, string>;
  /** Custom headers for HTTP requests */
  headers?: Record<string, string>;
  /** Filter events to export (default: all span events) */
  filter?: (event: TraceEvent) => boolean;
  /** Convert events at the export boundary, after filter and before OTLP conversion */
  convert?: TraceEventConverter;
  /** Batch size before sending (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Maximum buffered events before dropping new events (default: 5000) */
  maxQueueSize?: number;
  /** HTTP transport retry count for retryable failures (default: 3) */
  maxRetries?: number;
  /**
   * Bind flush to host lifecycle. Omit to use registerNodeShutdown() (Node-friendly default).
   * Pass false to skip (e.g. Workers: use ctx.waitUntil(disable()) instead). Pass a function
   * for full control. Shutdown flush timeout is configured on registerNodeShutdown options.
   */
  registerShutdown?: ExporterRegisterShutdown | false;
}

/**
 * Review exporter options
 */
export interface ReviewOptions {
  /**
   * Review server endpoint URL (e.g., 'http://localhost:5789/api/v1/traces')
   * @default "http://localhost:5789/api/v1/traces" or REJELLY_REVIEW_ENDPOINT env var
   */
  endpoint?: string;
  /** Custom event bus (optional, defaults to global) */
  eventBus?: EventBus;
  /** Custom headers for HTTP requests */
  headers?: Record<string, string>;
  /** Filter events to export (optional) */
  filter?: (event: TraceEvent) => boolean;
  /** Convert events at the export boundary, after filter and before Review serialization */
  convert?: TraceEventConverter;
  /** Batch size before sending (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Maximum buffered events before dropping new events (default: 5000) */
  maxQueueSize?: number;
  /** HTTP transport retry count for retryable failures (default: 3) */
  maxRetries?: number;
  /**
   * Bind flush to host lifecycle. Omit to use registerNodeShutdown() (Node-friendly default).
   * Pass false to skip (e.g. Workers: use ctx.waitUntil(disable()) instead). Pass a function
   * for full control. Shutdown flush timeout is configured on registerNodeShutdown options.
   */
  registerShutdown?: ExporterRegisterShutdown | false;
}
