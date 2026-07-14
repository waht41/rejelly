import type * as NormalizedTrace from "@entities/trace/types/normalizedTrace";

/** Empty normalized trace for processor bootstrap. */
export function createEmptyNormalizedTrace(
  traceId: string,
  initial?: Pick<NormalizedTrace.Trace, "name" | "startTime" | "status" | "metadata">,
): NormalizedTrace.Trace {
  return {
    id: traceId,
    name: initial?.name,
    nodeMap: {},
    structuralRootIds: [],
    waterfall: {
      aggregatedSpans: new Map(),
      aggregatedRootSpanIds: [],
    },
    startTime: initial?.startTime ?? Date.now(),
    status: initial?.status ?? "running",
    metadata: initial?.metadata,
  };
}
