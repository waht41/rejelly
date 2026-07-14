/**
 * Review Exporter
 *
 * Sends trace events to Rejelly Review Server in realtime mode.
 * Supports both :start and :end events for live trace visualization.
 * Uses original event format (no OTLP conversion).
 *
 * Monotonic `_seq` is assigned at export time (this module only) so Core stays free of
 * transport concerns; consumers should sort by timestamp first and use `_seq` only to
 * stabilize events with identical timestamps.
 */

import type { TraceEvent } from "../core/domain/events";
import { createBatchExporter } from "./exporter-core";
import { createHttpSender } from "./http-transport";
import { registerNodeShutdown } from "./shutdown-node";
import type { ReviewOptions } from "./types";

// ============ Review Exporter ============
const DEFAULT_REVIEW_ENDPOINT = "http://localhost:5789/api/v1/traces";

/**
 * Enable Review exporter
 *
 * Sends trace events to Rejelly Review Server in realtime mode.
 * Supports both :start and :end events for live trace visualization.
 *
 * @param opts - Review exporter options
 * @returns Disable function
 *
 * @example
 * const disable = enableReview({
 *   endpoint: 'http://localhost:5789/api/v1/traces',
 * });
 * await MyAgent({ topic: 'test' });
 * await disable(); // Flushes remaining events
 * @param opts
 */
export function enableReview(opts: ReviewOptions = {}): () => Promise<void> {
  // Resolve endpoint safely across Node.js and browser/Edge runtimes.
  const envEndpoint =
    typeof process !== "undefined" && process.env ? process.env.REJELLY_REVIEW_ENDPOINT : undefined;
  const endpoint = opts.endpoint || envEndpoint || DEFAULT_REVIEW_ENDPOINT;

  const registerShutdown =
    opts.registerShutdown === false ? undefined : (opts.registerShutdown ?? registerNodeShutdown());

  // Build headers with authentication
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };

  // Per-exporter channel: tie-breaker for identical timestamps after network reordering.
  let reviewSeq = 0;

  return createBatchExporter<TraceEvent & { _seq: number }>({
    // 1. Realtime filter: allow Start events
    filter: (event) => (opts.filter ? opts.filter(event) : true),

    // 2. Transform: export-boundary convert + `_seq` (does not mutate EventBus payloads)
    transform: async (event) => ({
      ...(opts.convert ? await opts.convert({ ...event }) : event),
      _seq: reviewSeq++,
    }),

    // 3. Send logic: HTTP transport owns retry and circuit breaking
    send: createHttpSender({ endpoint, headers, maxRetries: opts.maxRetries }, (events) =>
      JSON.stringify(events),
    ),

    // Override default config: realtime requires smaller batch and faster flush
    batchSize: opts.batchSize,
    flushInterval: opts.flushInterval,
    maxQueueSize: opts.maxQueueSize,
    registerShutdown,
    eventBus: opts.eventBus,
  });
}
