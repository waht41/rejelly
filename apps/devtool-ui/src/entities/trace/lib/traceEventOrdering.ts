import type { TraceEvent } from "@rejelly/core";

type TraceEventWithSeq = TraceEvent & { _seq?: number };

export function compareTraceEventsByTimestampAndSeq(a: TraceEvent, b: TraceEvent): number {
  const timestampDiff = a.timestamp - b.timestamp;
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const aSeq = (a as TraceEventWithSeq)._seq;
  const bSeq = (b as TraceEventWithSeq)._seq;

  if (aSeq !== undefined && bSeq !== undefined) {
    const seqDiff = aSeq - bSeq;
    if (seqDiff !== 0) {
      return seqDiff;
    }
  } else if (aSeq !== undefined) {
    return -1;
  } else if (bSeq !== undefined) {
    return 1;
  }

  return 0;
}

export function sortTraceEventsByTimestampAndSeq<T extends TraceEvent>(events: T[]): T[] {
  return events.sort(compareTraceEventsByTimestampAndSeq);
}

export function getLastTraceEventByTimestampAndSeq<T extends TraceEvent>(
  events: readonly T[],
): T | undefined {
  if (events.length === 0) {
    return undefined;
  }
  const sorted = [...events].sort(compareTraceEventsByTimestampAndSeq);
  return sorted[sorted.length - 1];
}
