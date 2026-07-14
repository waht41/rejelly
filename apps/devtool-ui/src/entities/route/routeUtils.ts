/**
 * URL builder utilities for trace pages.
 * Route matching/parsing should be handled by React Router directly.
 */

export type TraceViewMode = "detail" | "waterfall";

export function buildTracePath(traceId: string | null | undefined, mode: TraceViewMode): string {
  if (traceId) {
    return `/trace/${traceId}/${mode}`;
  }
  return `/trace/${mode}`;
}
