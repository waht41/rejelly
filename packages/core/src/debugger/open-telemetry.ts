/**
 * OTLP Exporter
 *
 * Sends trace events to an OTLP-compatible server.
 * Uses HTTP/JSON format for simplicity (no protobuf dependency).
 *
 * Note: This module is designed for Node.js but also works in browsers with fetch support.
 */

import type { TraceEvent } from "../core/domain/events";
import { createBatchExporter, normalizePositiveInteger } from "./exporter-core";
import { createHttpSender } from "./http-transport";
import {
  buildOTLPPayload,
  eventToOTLPSpan,
  getPointEventTargetSpanId,
  isPointEvent,
  isSpanEvent,
  type OTLPSpan,
  type OTLPSpanEvent,
  pointEventToOTLPSpanEvent,
} from "./otlp-converter";
import { registerNodeShutdown } from "./shutdown-node";
import type { OTLPOptions } from "./types";

const spanEventKey = (traceId: string, spanId: string): string => `${traceId}:${spanId}`;

/**
 * Enable OTLP exporter
 *
 * Sends trace events to an OTLP-compatible server (e.g., Jaeger, Zipkin, Tempo).
 *
 * @param options - Exporter options
 * @returns Disable function
 *
 * @example
 * const disable = enableOTLP({
 *   endpoint: 'http://localhost:4318/v1/traces',
 *   serviceName: 'my-agent-app',
 * });
 * await MyAgent({ topic: 'test' });
 * await disable(); // Flushes remaining events
 */
export function enableOTLP(options: OTLPOptions): () => Promise<void> {
  const opts: OTLPOptions = {
    serviceName: "rejelly",
    resourceAttributes: {},
    headers: {},
    batchSize: 10,
    flushInterval: 5000,
    ...options,
  };

  const registerShutdown =
    opts.registerShutdown === false ? undefined : (opts.registerShutdown ?? registerNodeShutdown());

  const pendingSpanEvents = new Map<string, OTLPSpanEvent[]>();
  let pendingSpanEventCount = 0;
  const maxQueueSize = normalizePositiveInteger(opts.maxQueueSize, 5000);

  const send = createHttpSender<OTLPSpan>(
    {
      endpoint: opts.endpoint,
      headers: {
        "Content-Type": "application/json",
        ...opts.headers,
      },
      maxRetries: opts.maxRetries,
    },
    (spans) => JSON.stringify(buildOTLPPayload(spans, opts.serviceName!, opts.resourceAttributes!)),
  );

  // Point-event folding has an ordering contract: a point event is attached to its target span
  // (getPointEventTargetSpanId) only when that span's :end is later exported and triggers
  // attachPendingEvents. So every point event MUST be emitted *before* its target span's :end.
  // Events arriving after their target span is exported become orphans (warned + dropped on
  // disable). agent:reborn is the notable case — agent.ts emits it just before generation:end
  // for exactly this reason.
  const rememberPointEvent = (event: TraceEvent): void => {
    const targetSpanId = getPointEventTargetSpanId(event);
    if (!targetSpanId) {
      console.warn("[OTLP] Dropping point event without target span", event.type);
      return;
    }

    if (pendingSpanEventCount >= maxQueueSize) {
      const oldest = pendingSpanEvents.keys().next().value;
      if (oldest) {
        const events = pendingSpanEvents.get(oldest) ?? [];
        pendingSpanEventCount -= events.length;
        pendingSpanEvents.delete(oldest);
      }
      console.warn("[OTLP] Point event queue full, dropping oldest target span events");
    }

    const key = spanEventKey(event.trace.traceId, targetSpanId);
    const events = pendingSpanEvents.get(key) ?? [];
    events.push(pointEventToOTLPSpanEvent(event));
    pendingSpanEvents.set(key, events);
    pendingSpanEventCount += 1;
  };

  const attachPendingEvents = (event: TraceEvent, span: OTLPSpan): void => {
    const key = spanEventKey(event.trace.traceId, event.trace.spanId);
    const events = pendingSpanEvents.get(key);
    if (!events || events.length === 0) return;

    span.events = [...(span.events ?? []), ...events];
    pendingSpanEventCount -= events.length;
    pendingSpanEvents.delete(key);
  };

  const disable = createBatchExporter<OTLPSpan>({
    eventBus: opts.eventBus,
    batchSize: opts.batchSize,
    flushInterval: opts.flushInterval,
    maxQueueSize: opts.maxQueueSize,
    registerShutdown,
    filter: (event) => (opts.filter ? opts.filter(event) : true),
    transform: async (event) => {
      const convertedEvent = opts.convert ? await opts.convert({ ...event }) : event;

      if (isPointEvent(convertedEvent)) {
        rememberPointEvent(convertedEvent);
        return undefined;
      }

      if (!isSpanEvent(convertedEvent, { realtime: false })) {
        return undefined;
      }

      const span = eventToOTLPSpan(convertedEvent, { realtime: false });
      attachPendingEvents(convertedEvent, span);
      return span;
    },
    send,
  });

  return async () => {
    await disable();

    if (pendingSpanEventCount > 0) {
      console.warn(
        `[OTLP] Dropping ${pendingSpanEventCount} point event(s) without exported parent span`,
      );
      pendingSpanEvents.clear();
      pendingSpanEventCount = 0;
    }
  };
}
