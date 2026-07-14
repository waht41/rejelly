/**
 * Event Handler Types
 */

import type { TraceEvent } from "@rejelly/core";
import type { NormalizedTrace } from "../../../types";
import type { TraceLinker } from "../TraceLinker";

export interface TraceWriteApi {
  addNode: (node: NormalizedTrace.TraceNode) => void;
  updateNode: <TNode extends NormalizedTrace.TraceNode>(
    spanId: string,
    updater: (node: TNode) => void,
  ) => TNode | undefined;
  setTraceStartTime: (startTime: number) => void;
  setTraceStatus: (status: NormalizedTrace.Trace["status"]) => void;
  setTraceEndTime: (endTime: number | undefined) => void;
  addStructuralRoot: (spanId: string) => void;
  replaceStructuralRootIds: (rootIds: string[]) => void;
  appendMountedDetailId: (spanId: string, detailSpanId: string) => void;
  appendMountedStructuralId: (spanId: string, childSpanId: string) => void;
  replaceMountedStructuralIds: (spanId: string, childSpanIds: string[]) => void;
  upsertAggregatedSpan: (span: NormalizedTrace.AggregatedSpan) => void;
  updateAggregatedSpan: (
    spanId: string,
    updater: (span: NormalizedTrace.AggregatedSpan) => void,
  ) => NormalizedTrace.AggregatedSpan | undefined;
  addAggregatedRootSpanId: (spanId: string) => void;
}

/**
 * Context passed to event handlers
 * Only contains shared data, no business logic methods
 */
export interface TraceContext extends TraceWriteApi {
  normalizedTrace: NormalizedTrace.Trace;
  prevMemoryMap: Map<string, Record<string, unknown>>;
  traceLinker: TraceLinker;
}

/**
 * Event handler interface
 */
export interface EventHandler {
  /**
   * Check if this handler can process the event
   */
  filter: (event: TraceEvent) => boolean;
  /**
   * Handle the event
   */
  handle(event: TraceEvent, ctx: TraceContext): void;
}
