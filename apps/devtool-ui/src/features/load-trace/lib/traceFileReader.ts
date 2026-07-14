/**
 * Pure trace file parsing utility.
 * No React/Zustand dependency - only I/O and data transformation.
 */

import { groupEventsByTraceId, parseTraceEventsFromFile } from "@features/load-trace/lib/fileUtils";
import type { TraceEvent } from "@rejelly/core";

export type ParsedTraceGroup = { traceId: string; events: TraceEvent[] };

/**
 * Read a trace file and return grouped trace data ready for store.
 * Supports JSON and JSONL formats; multiple traces in one file are grouped by traceId.
 */
export async function parseTraceFile(file: File): Promise<ParsedTraceGroup[]> {
  const events = await parseTraceEventsFromFile(file);
  return groupEventsByTraceId(events);
}
