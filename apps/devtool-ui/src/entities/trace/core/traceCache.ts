/**
 * Trace cache: in-memory + IndexedDB persistence (storage layer only).
 *
 * Events are written to both in-memory Map and IndexedDB.
 * Uses a Map for O(1) deduplication and insertion order preservation.
 * Includes a Promise queue to prevent IndexedDB write race conditions.
 */

import type { TraceEvent } from "@rejelly/core";
import {
  clearAllTraceEvents,
  getTraceEvents,
  removeTraceEvents,
  setTraceEvents,
} from "./traceStorage";

/**
 * Prefer native event id if TraceEvent has one; BaseTraceEvent has none, so we use
 * spanId+timestamp+type to reduce key collision.
 */
function eventKey(e: TraceEvent): string {
  if ("id" in e && e.id) return String(e.id);
  const eventType = "type" in e ? String(e.type) : "unknown";
  return `${e.trace.spanId}:${e.timestamp}:${eventType}`;
}

interface TraceCacheBucket {
  eventsMap: Map<string, TraceEvent>;
}

const eventCache = new Map<string, TraceCacheBucket>();

const writeQueue = new Map<string, Promise<void>>();

/**
 * Persist events to storage; Promise chain ensures serial IndexedDB writes per traceId.
 */
function persistEventsQueue(traceId: string, events: TraceEvent[]): void {
  const currentTask = writeQueue.get(traceId) || Promise.resolve();

  const nextTask = currentTask
    .then(() => setTraceEvents(traceId, events))
    .catch((error) => {
      console.error(`[TraceCache] Failed to persist trace ${traceId}:`, error);
    });

  writeQueue.set(traceId, nextTask);
}

function createBucket(events: TraceEvent[]): TraceCacheBucket {
  const map = new Map<string, TraceEvent>();
  for (const e of events) {
    map.set(eventKey(e), e);
  }
  return { eventsMap: map };
}

export function addEventsToCache(traceId: string, events: TraceEvent[]): void {
  if (!events || events.length === 0) return;

  let bucket = eventCache.get(traceId);
  if (!bucket) {
    bucket = { eventsMap: new Map() };
    eventCache.set(traceId, bucket);
  }

  let hasChanges = false;

  for (const e of events) {
    const key = eventKey(e);
    if (!bucket.eventsMap.has(key)) {
      bucket.eventsMap.set(key, e);
      hasChanges = true;
    }
  }

  if (hasChanges) {
    const updatedEvents = Array.from(bucket.eventsMap.values());

    // If events can arrive out of order, uncomment to sort by timestamp:
    // updatedEvents.sort((a, b) => a.timestamp - b.timestamp);

    persistEventsQueue(traceId, updatedEvents);
  }
}

export async function getEventsFromStorage(traceId: string): Promise<TraceEvent[]> {
  const bucket = eventCache.get(traceId);
  if (bucket && bucket.eventsMap.size > 0) {
    return Array.from(bucket.eventsMap.values());
  }

  try {
    const fromIdb = await getTraceEvents(traceId);
    if (fromIdb && fromIdb.length > 0) {
      eventCache.set(traceId, createBucket(fromIdb));
      return fromIdb;
    }
  } catch (error) {
    console.error(`[TraceCache] Failed to read trace ${traceId} from storage:`, error);
  }

  return [];
}

export function getEventsFromCache(traceId: string): TraceEvent[] {
  const bucket = eventCache.get(traceId);
  return bucket ? Array.from(bucket.eventsMap.values()) : [];
}

export function clearCache(traceId?: string): void {
  if (traceId) {
    eventCache.delete(traceId);
    writeQueue.delete(traceId);
    removeTraceEvents(traceId).catch(console.error);
  } else {
    eventCache.clear();
    writeQueue.clear();
    clearAllTraceEvents().catch(console.error);
  }
}
