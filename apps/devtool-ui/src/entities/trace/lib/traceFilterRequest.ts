import type { TraceFilterRequest } from "@entities/trace/api";

export const DEFAULT_TRACE_TIME_PRESET = "7d";

export type TraceTimePreset = Exclude<
  NonNullable<TraceFilterRequest["timeRange"]>["preset"],
  undefined
>;

export function getTraceTimePreset(request?: TraceFilterRequest | null): TraceTimePreset {
  return request?.timeRange?.preset ?? DEFAULT_TRACE_TIME_PRESET;
}

export function hasEffectiveTraceFilter(
  request?: TraceFilterRequest | null,
): request is TraceFilterRequest {
  if (!request) return false;

  const timeRange = request.timeRange;
  return (
    request.filters.length > 0 ||
    getTraceTimePreset(request) !== DEFAULT_TRACE_TIME_PRESET ||
    !!timeRange?.from ||
    !!timeRange?.to
  );
}
