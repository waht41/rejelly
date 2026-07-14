/**
 * Trace file import/export – no React/Zustand.
 * Import uploads parsed events to the server (single source of truth); the trace
 * then behaves like any server trace (AI, search, filter all work).
 * Export pulls raw TraceEvent[] from the API, not hydrated Trace objects.
 */

import { fetchTraceEvents, updateTrace, uploadTraceEvents } from "@entities/trace/api";
import type { TraceEvent } from "@rejelly/core";
import { parseTraceFile } from "./traceFileReader";

/** Tag applied to traces created via local file import, so they are distinguishable and purgeable. */
export const IMPORTED_TRACE_TAG = "imported";

/**
 * Load canonical events for export from the server.
 */
export async function loadTraceEventsForExport(traceId: string): Promise<TraceEvent[]> {
  return fetchTraceEvents(traceId);
}

function sortEventsByTime(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Browser download: one JSON object per line (.jsonl / NDJSON).
 */
export function downloadTraceEventsAsJsonl(events: TraceEvent[], traceId: string): void {
  const sorted = sortEventsByTime(events);
  const lines = sorted.map((e) => JSON.stringify(e));
  const content = lines.join("\n") + (lines.length ? "\n" : "");
  const blob = new Blob([content], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `trace-${traceId}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Parse a trace file and upload each contained trace to the server, tagging it
 * as imported. Returns the resolved traceIds (in file order) so the caller can
 * navigate to the first and refresh the server-backed history list.
 * Throws if the file has no trace data.
 */
export async function processTraceFile(file: File): Promise<string[]> {
  const groupedTraces = await parseTraceFile(file);
  if (!groupedTraces.length) {
    throw new Error("Invalid trace file: no trace data");
  }

  const traceIds: string[] = [];
  for (const group of groupedTraces) {
    if (group.events.length === 0) continue;
    const { traceId } = await uploadTraceEvents(group.events);
    // Tag after ingest so the summary row exists; failure to tag is non-fatal.
    await updateTrace(traceId, { tags: [IMPORTED_TRACE_TAG] }).catch(() => {});
    traceIds.push(traceId);
  }

  if (traceIds.length === 0) {
    throw new Error("Invalid trace file: no trace data");
  }
  return traceIds;
}
