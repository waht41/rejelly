/**
 * IndexedDB persistence for trace events (payload only).
 * Survives F5 / HMR so DevTool UI can restore the last viewed trace.
 * Uses idb-keyval for a minimal API; no size limit like localStorage.
 */

import type { TraceEvent } from "@rejelly/core";
import { clear, createStore, del, get, set } from "idb-keyval";

const TRACE_DB = "devtool-trace-db";
const TRACE_STORE = "trace-events";
const store = createStore(TRACE_DB, TRACE_STORE);

const key = (traceId: string) => `trace_events_${traceId}`;

export function setTraceEvents(traceId: string, events: TraceEvent[]): Promise<void> {
  return set(key(traceId), events, store);
}

export function getTraceEvents(traceId: string): Promise<TraceEvent[] | undefined> {
  return get(key(traceId), store);
}

export function removeTraceEvents(traceId: string): Promise<void> {
  return del(key(traceId), store);
}

export function clearAllTraceEvents(): Promise<void> {
  return clear(store);
}
