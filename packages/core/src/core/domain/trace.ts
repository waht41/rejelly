/**
 * Trace context for debugging/telemetry
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  /** Additional attributes for the span */
  attributes?: Record<string, unknown>;
}
