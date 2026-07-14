type TraceDisplayNameSource = {
  name?: string | null;
};

export const UNTITLED_TRACE_NAME = "Untitled Trace";

export function getTraceDisplayName(
  source?: TraceDisplayNameSource | null,
  fallbackName?: string | null,
): string | undefined {
  return source?.name ?? fallbackName ?? undefined;
}

export function getTraceDisplayNameOrUntitled(
  source?: TraceDisplayNameSource | null,
  fallbackName?: string | null,
): string {
  return getTraceDisplayName(source, fallbackName) ?? UNTITLED_TRACE_NAME;
}
