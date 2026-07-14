/**
 * Trace API: fetch trace events, history, list from server
 */

import type { TraceEvent } from "@rejelly/core";
import type {
  ListTracesQuery,
  ListTracesResponse,
  TraceFilterChatMessage,
  TraceFilterGenerateContext,
  TraceFilterGenerateResponse,
  TraceFilterRequest,
  TraceSummaryPatch,
  TraceSummaryResponse,
} from "@shared/api-types/traces";

export type {
  BuiltinFilter,
  BuiltinFilterKey,
  ListTracesQuery,
  ListTracesResponse,
  RootAttrEqFilter,
  RootAttrFilter,
  TraceFilterChatMessage,
  TraceFilterGenerateContext,
  TraceFilterGenerateResponse,
  TraceFilterNode,
  TraceFilterOp,
  TraceFilterRequest,
  TraceFilterValue,
  TraceSummaryPatch,
  TraceSummaryResponse,
} from "@shared/api-types/traces";

/**
 * Fetch trace events for a specific trace
 * @param traceId - The trace ID to fetch events for
 * @param signal - Optional AbortSignal for request cancellation
 * @returns Promise resolving to array of trace events
 */
export async function fetchTraceEvents(
  traceId: string,
  signal?: AbortSignal,
): Promise<TraceEvent[]> {
  const url = `/api/v1/traces/${traceId}/events`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch trace history/list from server
 * @param page - Page number (1-indexed)
 * @param num - Number of traces per page
 * @returns Promise resolving to array of trace summaries
 */
export async function fetchTraceHistory(
  page: number,
  num: number,
): Promise<TraceSummaryResponse[]> {
  const queryParams = new URLSearchParams();
  queryParams.set("page", String(page));
  queryParams.set("num", String(num));
  const url = `/api/v1/traces?${queryParams.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch single trace summary by ID
 * @param traceId - The trace ID to fetch
 * @returns Promise resolving to trace summary
 */
export async function fetchTraceSummary(traceId: string): Promise<TraceSummaryResponse> {
  const url = `/api/v1/traces/${traceId}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Fetch traces with filtering and sorting
 * @param options - Query options
 * @returns Promise resolving to list traces response
 */
export async function fetchTraces(
  options: {
    signal?: AbortSignal;
  } & ListTracesQuery,
): Promise<ListTracesResponse> {
  const queryParams = new URLSearchParams();
  if (options.pageSize !== undefined) {
    queryParams.set("pageSize", String(options.pageSize));
  }
  if (options.page !== undefined) {
    queryParams.set("page", String(options.page));
  }
  if (options.status) {
    queryParams.set("status", options.status);
  }
  if (options.entryType) {
    queryParams.set("entryType", options.entryType);
  }
  if (options.name) {
    queryParams.set("name", options.name);
  }
  if (options.isStarred !== undefined) {
    queryParams.set("isStarred", String(options.isStarred));
  }
  if (options.startTime !== undefined) {
    queryParams.set("startTime", String(options.startTime));
  }
  if (options.endTime !== undefined) {
    queryParams.set("endTime", String(options.endTime));
  }
  if (options.order) {
    queryParams.set("order", options.order);
  }

  const url = `/api/v1/traces?${queryParams.toString()}`;
  const res = await fetch(url, { signal: options.signal });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Upload trace events to the server ingest endpoint. The server ingest is
 * idempotent (deterministic event ids + ON CONFLICT DO NOTHING), so re-uploading
 * the same events is safe and will not duplicate rows or double-count summaries.
 * @returns The resolved traceId and the number of newly stored events.
 */
export async function uploadTraceEvents(
  events: TraceEvent[],
): Promise<{ traceId: string; eventCount: number }> {
  const res = await fetch("/api/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(events),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

export async function searchTraces(
  request: TraceFilterRequest,
  signal?: AbortSignal,
): Promise<ListTracesResponse> {
  const res = await fetch("/api/v1/traces/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Generate a trace filter AST from natural language.
 * Pass the accumulated `delta` messages back as `history` for follow-up corrections.
 */
export async function generateTraceFilter(
  prompt: string,
  history: TraceFilterChatMessage[] = [],
  context?: TraceFilterGenerateContext | null,
  signal?: AbortSignal,
): Promise<TraceFilterGenerateResponse> {
  const res = await fetch("/api/v1/ai/filter", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, history, context }),
    signal,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

/**
 * Update trace metadata (name, isStarred, tags)
 * @param traceId - The trace ID to update
 * @param updates - Partial updates to apply
 */
export async function updateTrace(traceId: string, updates: TraceSummaryPatch): Promise<void> {
  const url = `/api/v1/traces/${traceId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
}
