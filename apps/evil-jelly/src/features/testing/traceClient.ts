import type { TraceEvent } from "@rejelly/core";
import { getReviewEndpointFromEnv } from "../../shared/config";

export async function fetchTraceEvents(traceId: string): Promise<TraceEvent[]> {
  const base = getReviewEndpointFromEnv().replace(/\/$/, "");
  const url = `${base}/${encodeURIComponent(traceId)}/events`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchTraceEvents: HTTP ${res.status} GET ${url}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`fetchTraceEvents: expected a JSON array of events from ${url}`);
  }
  return data as TraceEvent[];
}
