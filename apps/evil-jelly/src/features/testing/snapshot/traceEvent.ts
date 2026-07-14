/**
 * TraceEvent layer: plain JSON rows (legacy flatten shape or native export) → @rejelly/core TraceEvent.
 */

import type { TraceEvent } from "@rejelly/core";
import type { JsonlObject } from "./jsonl";

/** Remove exporter-only fields that are not part of core TraceEvent. */
function stripAuxFields(row: JsonlObject): JsonlObject {
  const { _seq: _s, ...rest } = row;
  return rest;
}

/**
 * One JSON object → TraceEvent. Supports:
 * - File logger shape: top-level traceId / spanId / parentSpanId + ISO timestamp
 * - Native shape: nested `trace` + numeric or ISO `timestamp`
 */
export function traceEventFromJsonRow(raw: JsonlObject): TraceEvent {
  const row = stripAuxFields(raw);

  if (row.trace && typeof row.trace === "object") {
    const t = row.timestamp;
    const ts = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : 0;
    return { ...row, timestamp: ts } as TraceEvent;
  }

  const { type, agentId, timestamp, traceId, spanId, parentSpanId, ...payload } = row;

  const ts =
    typeof timestamp === "string"
      ? Date.parse(timestamp)
      : typeof timestamp === "number"
        ? timestamp
        : 0;

  return {
    type,
    agentId: agentId as string | undefined,
    timestamp: ts,
    trace: {
      traceId: String(traceId ?? ""),
      spanId: String(spanId ?? ""),
      parentSpanId: String(parentSpanId ?? ""),
    },
    ...payload,
  } as TraceEvent;
}

/** Map JSONL rows to trace events in order. */
export function jsonlObjectsToTraceEvents(rows: JsonlObject[]): TraceEvent[] {
  return rows.map((r) => traceEventFromJsonRow(r));
}
