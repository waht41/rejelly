/**
 * OTLP Converter
 *
 * Converts TraceEvent to OTLP span format.
 * Supports two modes:
 * - Strict: Only :end events (standard OTLP)
 * - Realtime: :start events (endTime=0) + :end events
 */

import { EVENTS, type TraceEvent } from "../core/domain/events";
import { logger } from "../core/shared/logger/instance";

/**
 * Prefix reserved for framework-emitted span attributes. Everything the framework writes
 * lives under the single `rejelly.` namespace (rejelly.span_type, rejelly.agent.id,
 * rejelly.event.*), so user-supplied trace attributes hitting it are skipped to prevent
 * shadowing structural data. The `rejelly.` namespace also avoids colliding with OTel
 * semantic conventions (e.g. the reserved `event.name` attribute).
 */
const RESERVED_ATTR_PREFIXES = ["rejelly."] as const;

// ============ Types ============

export interface OTLPSpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: OTLPAttribute[];
}

export interface OTLPSpanLink {
  traceId: string;
  spanId: string;
  attributes?: OTLPAttribute[];
}

export interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string; // Optional: omit for root spans (Jaeger requires valid 16-char hex or no field)
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OTLPAttribute[];
  events?: OTLPSpanEvent[];
  links?: OTLPSpanLink[];
  status: { code: number; message?: string };
}

export interface OTLPAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: {
      values: Array<{
        stringValue?: string;
        intValue?: string;
        doubleValue?: number;
        boolValue?: boolean;
      }>;
    };
  };
}

export interface OTLPPayload {
  resourceSpans: Array<{
    resource: { attributes: OTLPAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OTLPSpan[];
    }>;
  }>;
}

export interface ConverterOptions {
  /**
   * Whether to enable realtime mode
   * true: Send :start events (endTime=0)
   * false: Only send :end events (standard OTLP)
   */
  realtime: boolean;
}

// ============ Helpers ============

/**
 * Parse timestamp to milliseconds, handling various formats
 */
function parseTimestamp(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

function millisecondsToNanoseconds(ms: number): bigint {
  return BigInt(Math.round(ms * 1_000_000));
}

/**
 * Get span name from event.
 * Custom span: use event.name.
 * System spans: strip :end / :start from event.type.
 */
function getSpanName(event: TraceEvent): string {
  if ("name" in event && typeof event.name === "string") {
    return event.name;
  }
  return event.type.replace(/:end$/, "").replace(/:start$/, "");
}

/**
 * Whether this event is a custom span (user-defined name).
 */
function isCustomSpanEvent(event: TraceEvent): boolean {
  return event.type === "custom:span:start" || event.type === "custom:span:end";
}

/**
 * Convert a single value to OTLP attribute value
 */
function valueToOTLPValue(value: unknown): {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
} {
  if (typeof value === "string") {
    return { stringValue: value };
  } else if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    } else {
      return { doubleValue: value };
    }
  } else if (typeof value === "boolean") {
    return { boolValue: value };
  } else {
    // Serialize complex objects as JSON string
    return { stringValue: JSON.stringify(value) };
  }
}

/**
 * Convert array to OTLP array value
 */
function arrayToOTLPArrayValue(arr: unknown[]): {
  arrayValue: {
    values: Array<{
      stringValue?: string;
      intValue?: string;
      doubleValue?: number;
      boolValue?: boolean;
    }>;
  };
} {
  return {
    arrayValue: {
      values: arr.map((item) => valueToOTLPValue(item)),
    },
  };
}

/**
 * Pad hex string to required length
 */
function padHex(hex: string, length: number): string {
  if (hex.length >= length) return hex.slice(0, length);
  return hex.padStart(length, "0");
}

/**
 * Create OTLP exception event from error info
 */
function createExceptionEvent(
  errorInfo: { name?: string; message?: string; stack?: string },
  timeNano: bigint,
): OTLPSpanEvent {
  const errorAttrs: OTLPAttribute[] = [];

  errorAttrs.push({
    key: "exception.type",
    value: { stringValue: errorInfo.name || "Error" },
  });
  errorAttrs.push({
    key: "exception.message",
    value: { stringValue: errorInfo.message || "" },
  });
  if (errorInfo.stack) {
    errorAttrs.push({
      key: "exception.stacktrace",
      value: { stringValue: errorInfo.stack },
    });
  }

  return {
    name: "exception",
    timeUnixNano: timeNano.toString(),
    attributes: errorAttrs,
  };
}

function eventPayloadAttributes(event: TraceEvent): OTLPAttribute[] {
  const attributes: OTLPAttribute[] = [];

  attributes.push({ key: "rejelly.event.type", value: { stringValue: event.type } });
  if (event.agentId) {
    attributes.push({ key: "rejelly.agent.id", value: { stringValue: event.agentId } });
  }

  for (const [key, value] of Object.entries(event)) {
    if (key === "type" || key === "trace" || key === "timestamp" || key === "agentId") continue;
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      attributes.push({
        key: `rejelly.event.${key}`,
        value: arrayToOTLPArrayValue(value),
      });
    } else if (typeof value === "string") {
      attributes.push({ key: `rejelly.event.${key}`, value: { stringValue: value } });
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        attributes.push({ key: `rejelly.event.${key}`, value: { intValue: String(value) } });
      } else {
        attributes.push({ key: `rejelly.event.${key}`, value: { doubleValue: value } });
      }
    } else if (typeof value === "boolean") {
      attributes.push({ key: `rejelly.event.${key}`, value: { boolValue: value } });
    } else {
      attributes.push({
        key: `rejelly.event.${key}`,
        value: { stringValue: JSON.stringify(value) },
      });
    }
  }

  const traceAttributes = event.trace.attributes;
  if (traceAttributes) {
    for (const [key, value] of Object.entries(traceAttributes)) {
      if (value === undefined || value === null) continue;
      if (RESERVED_ATTR_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        logger.warn("[otlp-converter] skipping trace attribute with reserved prefix", {
          key,
          reservedPrefixes: RESERVED_ATTR_PREFIXES,
        });
        continue;
      }
      attributes.push({
        key,
        value: Array.isArray(value) ? arrayToOTLPArrayValue(value) : valueToOTLPValue(value),
      });
    }
  }

  return attributes;
}

export function isPointEvent(event: TraceEvent): boolean {
  if (event.type.endsWith(":start") || event.type.endsWith(":end")) {
    return false;
  }

  return !("duration" in event && typeof event.duration === "number");
}

export function getPointEventTargetSpanId(event: TraceEvent): string | undefined {
  if (event.type === EVENTS.SYS_LOG) {
    return event.trace.spanId;
  }
  return event.trace.parentSpanId;
}

export function pointEventToOTLPSpanEvent(event: TraceEvent): OTLPSpanEvent {
  return {
    name: event.type,
    timeUnixNano: millisecondsToNanoseconds(parseTimestamp(event.timestamp)).toString(),
    attributes: eventPayloadAttributes(event),
  };
}

// ============ Converter Functions ============

/**
 * Check if event should be converted to a span
 *
 * @param event - Trace event
 * @param options - Converter options
 * @returns Whether the event should be converted
 */
export function isSpanEvent(event: TraceEvent, options: ConverterOptions): boolean {
  // Realtime mode: allow :start events
  if (options.realtime && event.type.endsWith(":start")) return true;
  return !event.type.endsWith(":start");
}

/**
 * Convert TraceEvent to OTLP span format
 *
 * @param event - Trace event
 * @param options - Converter options
 * @returns OTLP span
 */
export function eventToOTLPSpan(event: TraceEvent, options: ConverterOptions): OTLPSpan {
  const currentTimeMs = parseTimestamp(event.timestamp);
  const currentTsNano = millisecondsToNanoseconds(currentTimeMs);

  let startNano: bigint;
  let endNano: bigint;

  // Handle realtime mode: :start events
  if (options.realtime && event.type.endsWith(":start")) {
    startNano = currentTsNano;
    endNano = BigInt(0); // Mark as in-progress
  } else {
    // Standard logic: calculate start time from duration
    endNano = currentTsNano;

    // Get duration from event (most events use 'duration' field)
    let durationMs = 0;
    if ("duration" in event && typeof event.duration === "number") {
      durationMs = event.duration;
    }
    startNano = endNano - millisecondsToNanoseconds(durationMs);
  }

  const attributes: OTLPAttribute[] = [];

  attributes.push({
    key: "rejelly.span_type",
    value: { stringValue: isCustomSpanEvent(event) ? "custom" : "system" },
  });

  if (event.agentId) {
    attributes.push({ key: "rejelly.agent.id", value: { stringValue: event.agentId } });
  }

  // Add event-specific attributes (skip error/errors, we handle them separately)
  const { type, trace, timestamp, agentId, error, errors, ...payload } = event as TraceEvent & {
    error?: unknown;
    errors?: unknown;
  };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;

    // Handle arrays
    if (Array.isArray(value)) {
      attributes.push({
        key: `rejelly.event.${key}`,
        value: arrayToOTLPArrayValue(value),
      });
    } else if (typeof value === "string") {
      attributes.push({ key: `rejelly.event.${key}`, value: { stringValue: value } });
    } else if (typeof value === "number") {
      // Use intValue for integers, doubleValue for floats
      if (Number.isInteger(value)) {
        attributes.push({ key: `rejelly.event.${key}`, value: { intValue: String(value) } });
      } else {
        attributes.push({ key: `rejelly.event.${key}`, value: { doubleValue: value } });
      }
    } else if (typeof value === "boolean") {
      attributes.push({ key: `rejelly.event.${key}`, value: { boolValue: value } });
    } else {
      // Serialize complex objects as JSON string
      attributes.push({
        key: `rejelly.event.${key}`,
        value: { stringValue: JSON.stringify(value) },
      });
    }
  }

  // Merge span-level attributes carried on the trace context (set via equipTraceAttr /
  // withSpan({ attributes })). These live on event.trace.attributes, not the event payload,
  // so the loop above never sees them. Promote verbatim so users query the exact key they
  // wrote (e.g. `userId`, not `rejelly.event.userId`); guard the framework-reserved prefix so a
  // stray user key cannot shadow rejelly.* structural attributes.
  const traceAttributes = event.trace.attributes;
  if (traceAttributes) {
    for (const [key, value] of Object.entries(traceAttributes)) {
      if (value === undefined || value === null) continue;
      if (RESERVED_ATTR_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        logger.warn("[otlp-converter] skipping trace attribute with reserved prefix", {
          key,
          reservedPrefixes: RESERVED_ATTR_PREFIXES,
        });
        continue;
      }
      attributes.push({
        key,
        value: Array.isArray(value) ? arrayToOTLPArrayValue(value) : valueToOTLPValue(value),
      });
    }
  }

  // Determine status from success field
  // For :start events in realtime mode, default to OK (will be updated when :end arrives)
  const success = "success" in event ? (event as { success: boolean }).success : true;
  const status: { code: number; message?: string } = success
    ? { code: 1 } // STATUS_CODE_OK
    : { code: 2 }; // STATUS_CODE_ERROR

  // Add error message to status if present
  if (error && typeof error === "object" && "message" in error) {
    status.message = (error as { message: string }).message;
  }

  const span: OTLPSpan = {
    traceId: padHex(event.trace.traceId.replace(/-/g, ""), 32),
    spanId: padHex(event.trace.spanId, 16),
    name: getSpanName(event),
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: startNano.toString(),
    endTimeUnixNano: endNano.toString(),
    attributes,
    status,
  };

  // Only set parentSpanId if it exists (Jaeger requires valid 16-char hex or omit the field)
  if (event.trace.parentSpanId) {
    span.parentSpanId = padHex(event.trace.parentSpanId, 16);
  }

  // Add exception events for errors (only for :end events, not :start)
  if (!event.type.endsWith(":start")) {
    const spanEvents: OTLPSpanEvent[] = [];

    // Handle single error (from end events)
    if (error && typeof error === "object") {
      const errorInfo = error as { name?: string; message?: string; stack?: string };
      spanEvents.push(createExceptionEvent(errorInfo, endNano));
    }

    // Handle errors array (from validation:fail)
    if (errors && Array.isArray(errors)) {
      for (const err of errors) {
        if (err && typeof err === "object") {
          spanEvents.push(
            createExceptionEvent(
              err as { name?: string; message?: string; stack?: string },
              endNano,
            ),
          );
        }
      }
    }

    if (spanEvents.length > 0) {
      span.events = spanEvents;
    }
  }

  // Events with an originSpanId link back to the span where the originating signal occurred.
  if ("originSpanId" in event && typeof event.originSpanId === "string") {
    span.links = [
      {
        traceId: padHex(event.trace.traceId.replace(/-/g, ""), 32),
        spanId: padHex(event.originSpanId, 16),
        attributes: [{ key: "link.type", value: { stringValue: "rejelly_link" } }],
      },
    ];
  }

  return span;
}

/**
 * Build OTLP payload
 *
 * @param spans - Array of OTLP spans
 * @param serviceName - Service name
 * @param resourceAttributes - Additional resource attributes
 * @returns OTLP payload
 */
export function buildOTLPPayload(
  spans: OTLPSpan[],
  serviceName: string,
  resourceAttributes: Record<string, string>,
): OTLPPayload {
  const resourceAttrs: OTLPAttribute[] = [
    { key: "service.name", value: { stringValue: serviceName } },
  ];

  for (const [key, value] of Object.entries(resourceAttributes)) {
    resourceAttrs.push({ key, value: { stringValue: value } });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: "rejelly", version: "1.0.0" },
            spans,
          },
        ],
      },
    ],
  };
}
