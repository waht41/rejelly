/**
 * Trace Processor — builds NormalizedTrace from raw TraceEvent batches.
 */

import type { TraceEvent } from "@rejelly/core";
import type { NormalizedTrace } from "../../types";
import { createEmptyNormalizedTrace } from "../lib/normalizedTraceFactory";
import {
  type EventHandler,
  linkWaterfallOrphans,
  NormAggregatedSpanHandler,
  NormGenerationHandler,
  NormStructuralHandler,
  NormUpdateLogHandler,
  rebuildStructuralTopology,
  type TraceContext,
} from "./handlers";
import { TraceLinker } from "./TraceLinker";

export class TraceProcessor {
  private normalizedTrace: NormalizedTrace.Trace;
  private prevMemoryMap: Map<string, Record<string, unknown>> = new Map();
  private traceLinker: TraceLinker;
  private handlers: EventHandler[];
  private totalNodesCount = 0;
  private activeNodesCount = 0;
  private errorNodesCount = 0;
  private maxEndTime = 0;
  private activeContext: TraceContext | null = null;
  private traceCloned = false;
  private nodeMapCloned = false;
  private structuralRootIdsCloned = false;
  private waterfallCloned = false;
  private aggregatedSpansCloned = false;
  private aggregatedRootSpanIdsCloned = false;

  constructor(traceId: string) {
    this.normalizedTrace = createEmptyNormalizedTrace(traceId);
    this.traceLinker = new TraceLinker(this.normalizedTrace, {
      addNode: (node) => this.addNode(node),
      updateNode: (spanId, updater) => this.updateNode(spanId, updater),
      setTraceStartTime: (startTime) => this.setTraceStartTime(startTime),
      setTraceStatus: (status) => this.setTraceStatus(status),
      setTraceEndTime: (endTime) => this.setTraceEndTime(endTime),
      addStructuralRoot: (spanId) => this.addStructuralRoot(spanId),
      replaceStructuralRootIds: (rootIds) => this.replaceStructuralRootIds(rootIds),
      appendMountedDetailId: (spanId, detailSpanId) =>
        this.appendMountedDetailId(spanId, detailSpanId),
      appendMountedStructuralId: (spanId, childSpanId) =>
        this.appendMountedStructuralId(spanId, childSpanId),
      replaceMountedStructuralIds: (spanId, childSpanIds) =>
        this.replaceMountedStructuralIds(spanId, childSpanIds),
      upsertAggregatedSpan: (span) => this.upsertAggregatedSpan(span),
      updateAggregatedSpan: (spanId, updater) => this.updateAggregatedSpan(spanId, updater),
      addAggregatedRootSpanId: (spanId) => this.addAggregatedRootSpanId(spanId),
    });
    this.handlers = [
      new NormAggregatedSpanHandler(),
      new NormStructuralHandler(),
      new NormGenerationHandler(),
      new NormUpdateLogHandler(),
    ];
  }

  /**
   * Process batch of raw events.
   * Handlers are idempotent: nodeMap is keyed by spanId and start/end events overwrite or no-op.
   * Batch input order is preserved; topology for late parents is repaired by TraceLinker.
   */
  processBatch(events: TraceEvent[]): {
    normalizedTrace: NormalizedTrace.Trace;
    hasChanges: boolean;
  } {
    this.beginBatch();
    for (const event of events) {
      this.dispatch(event);
    }

    this.traceLinker.setTrace(this.normalizedTrace);
    this.traceLinker.linkAllOrphans();
    linkWaterfallOrphans(this.createContext());
    rebuildStructuralTopology(this.createContext());
    this.updateNormalizedTraceStatus();
    return { normalizedTrace: this.normalizedTrace, hasChanges: this.hasBatchChanges() };
  }

  private dispatch(event: TraceEvent): void {
    const ctx = this.createContext();
    for (const handler of this.handlers) {
      if (handler.filter(event)) {
        handler.handle(event, ctx);
      }
    }
  }

  private createContext(): TraceContext {
    if (this.activeContext) {
      this.activeContext.normalizedTrace = this.normalizedTrace;
      return this.activeContext;
    }

    this.activeContext = {
      normalizedTrace: this.normalizedTrace,
      prevMemoryMap: this.prevMemoryMap,
      traceLinker: this.traceLinker,
      addNode: (node) => this.addNode(node),
      updateNode: (spanId, updater) => this.updateNode(spanId, updater),
      setTraceStartTime: (startTime) => this.setTraceStartTime(startTime),
      setTraceStatus: (status) => this.setTraceStatus(status),
      setTraceEndTime: (endTime) => this.setTraceEndTime(endTime),
      addStructuralRoot: (spanId) => this.addStructuralRoot(spanId),
      replaceStructuralRootIds: (rootIds) => this.replaceStructuralRootIds(rootIds),
      appendMountedDetailId: (spanId, detailSpanId) =>
        this.appendMountedDetailId(spanId, detailSpanId),
      appendMountedStructuralId: (spanId, childSpanId) =>
        this.appendMountedStructuralId(spanId, childSpanId),
      replaceMountedStructuralIds: (spanId, childSpanIds) =>
        this.replaceMountedStructuralIds(spanId, childSpanIds),
      upsertAggregatedSpan: (span) => this.upsertAggregatedSpan(span),
      updateAggregatedSpan: (spanId, updater) => this.updateAggregatedSpan(spanId, updater),
      addAggregatedRootSpanId: (spanId) => this.addAggregatedRootSpanId(spanId),
    };
    return this.activeContext;
  }

  /**
   * Roll up normalized trace status from nodeMap.
   */
  private updateNormalizedTraceStatus(): void {
    if (this.totalNodesCount === 0) {
      this.setTraceStatus("running");
      this.setTraceEndTime(undefined);
      return;
    }

    if (this.activeNodesCount === 0) {
      this.setTraceStatus(this.errorNodesCount > 0 ? "error" : "success");
      this.setTraceEndTime(this.maxEndTime > 0 ? this.maxEndTime : undefined);
    } else {
      this.setTraceStatus("running");
      this.setTraceEndTime(undefined);
    }
  }

  private beginBatch(): void {
    this.activeContext = null;
    this.traceCloned = false;
    this.nodeMapCloned = false;
    this.structuralRootIdsCloned = false;
    this.waterfallCloned = false;
    this.aggregatedSpansCloned = false;
    this.aggregatedRootSpanIdsCloned = false;
  }

  private hasBatchChanges(): boolean {
    return (
      this.nodeMapCloned ||
      this.traceCloned ||
      this.structuralRootIdsCloned ||
      this.waterfallCloned ||
      this.aggregatedSpansCloned ||
      this.aggregatedRootSpanIdsCloned
    );
  }

  private ensureNodeMapMutable(): void {
    if (this.nodeMapCloned) return;
    this.normalizedTrace = {
      ...this.normalizedTrace,
      nodeMap: { ...this.normalizedTrace.nodeMap },
    };
    this.traceCloned = true;
    this.nodeMapCloned = true;
    this.traceLinker.setTrace(this.normalizedTrace);
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private ensureStructuralRootIdsMutable(): void {
    if (this.structuralRootIdsCloned) return;
    this.normalizedTrace = {
      ...this.normalizedTrace,
      structuralRootIds: [...this.normalizedTrace.structuralRootIds],
    };
    this.traceCloned = true;
    this.structuralRootIdsCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private ensureWaterfallMutable(): void {
    if (this.waterfallCloned) return;
    this.normalizedTrace = {
      ...this.normalizedTrace,
      waterfall: { ...this.normalizedTrace.waterfall },
    };
    this.traceCloned = true;
    this.waterfallCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private ensureAggregatedSpansMutable(): void {
    this.ensureWaterfallMutable();
    if (this.aggregatedSpansCloned) return;
    this.normalizedTrace.waterfall = {
      ...this.normalizedTrace.waterfall,
      aggregatedSpans: new Map(this.normalizedTrace.waterfall.aggregatedSpans),
    };
    this.aggregatedSpansCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private ensureAggregatedRootSpanIdsMutable(): void {
    this.ensureWaterfallMutable();
    if (this.aggregatedRootSpanIdsCloned) return;
    this.normalizedTrace.waterfall = {
      ...this.normalizedTrace.waterfall,
      aggregatedRootSpanIds: [...this.normalizedTrace.waterfall.aggregatedRootSpanIds],
    };
    this.aggregatedRootSpanIdsCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private cloneNode<TNode extends NormalizedTrace.TraceNode>(node: TNode): TNode {
    return {
      ...node,
      mountedDetailIds: [...node.mountedDetailIds],
      mountedStructuralIds: [...node.mountedStructuralIds],
      ...(node.logEvents ? { logEvents: [...node.logEvents] } : {}),
      ...("rebornEvents" in node ? { rebornEvents: [...node.rebornEvents] } : {}),
      ...("events" in node ? { events: [...node.events] } : {}),
    } as TNode;
  }

  private addNode(node: NormalizedTrace.TraceNode): void {
    const previousNode = this.normalizedTrace.nodeMap[node.spanId];
    if (previousNode === node) return;
    this.ensureNodeMapMutable();
    this.normalizedTrace.nodeMap[node.spanId] = node;
    if (previousNode) {
      this.syncNodeStats(previousNode, node);
      return;
    }
    this.totalNodesCount += 1;
    this.syncNodeStats(undefined, node);
  }

  private updateNode<TNode extends NormalizedTrace.TraceNode>(
    spanId: string,
    updater: (node: TNode) => void,
  ): TNode | undefined {
    const node = this.normalizedTrace.nodeMap[spanId] as TNode | undefined;
    if (!node) return undefined;
    const draft = this.cloneNode(node);
    updater(draft);
    this.ensureNodeMapMutable();
    this.normalizedTrace.nodeMap[spanId] = draft;
    this.syncNodeStats(node, draft);
    return draft;
  }

  private setTraceStartTime(startTime: number): void {
    if (startTime >= this.normalizedTrace.startTime) return;
    this.normalizedTrace = { ...this.normalizedTrace, startTime };
    this.traceCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private setTraceStatus(status: NormalizedTrace.Trace["status"]): void {
    if (this.normalizedTrace.status === status) return;
    this.normalizedTrace = { ...this.normalizedTrace, status };
    this.traceCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private setTraceEndTime(endTime: number | undefined): void {
    if (this.normalizedTrace.endTime === endTime) return;
    this.normalizedTrace = { ...this.normalizedTrace, endTime };
    this.traceCloned = true;
    if (this.activeContext) this.activeContext.normalizedTrace = this.normalizedTrace;
  }

  private addStructuralRoot(spanId: string): void {
    if (this.normalizedTrace.structuralRootIds.includes(spanId)) return;
    this.ensureStructuralRootIdsMutable();
    this.normalizedTrace.structuralRootIds.push(spanId);
  }

  private replaceStructuralRootIds(rootIds: string[]): void {
    if (sameStringArray(this.normalizedTrace.structuralRootIds, rootIds)) return;
    this.ensureStructuralRootIdsMutable();
    this.normalizedTrace.structuralRootIds = rootIds;
  }

  private appendMountedDetailId(spanId: string, detailSpanId: string): void {
    this.updateNode(spanId, (node) => {
      if (!node.mountedDetailIds.includes(detailSpanId)) {
        node.mountedDetailIds.push(detailSpanId);
      }
    });
  }

  private appendMountedStructuralId(spanId: string, childSpanId: string): void {
    this.updateNode(spanId, (node) => {
      if (!node.mountedStructuralIds.includes(childSpanId)) {
        node.mountedStructuralIds.push(childSpanId);
      }
    });
  }

  private replaceMountedStructuralIds(spanId: string, childSpanIds: string[]): void {
    const current = this.normalizedTrace.nodeMap[spanId];
    if (!current || sameStringArray(current.mountedStructuralIds, childSpanIds)) return;
    this.updateNode(spanId, (node) => {
      node.mountedStructuralIds = childSpanIds;
    });
  }

  private upsertAggregatedSpan(span: NormalizedTrace.AggregatedSpan): void {
    this.ensureAggregatedSpansMutable();
    this.normalizedTrace.waterfall.aggregatedSpans.set(span.id, span);
  }

  private updateAggregatedSpan(
    spanId: string,
    updater: (span: NormalizedTrace.AggregatedSpan) => void,
  ): NormalizedTrace.AggregatedSpan | undefined {
    const current = this.normalizedTrace.waterfall.aggregatedSpans.get(spanId);
    if (!current) return undefined;
    const draft: NormalizedTrace.AggregatedSpan = {
      ...current,
      childrenIds: [...current.childrenIds],
      ...(current.logEvents ? { logEvents: [...current.logEvents] } : {}),
    };
    updater(draft);
    this.ensureAggregatedSpansMutable();
    this.normalizedTrace.waterfall.aggregatedSpans.set(spanId, draft);
    return draft;
  }

  private addAggregatedRootSpanId(spanId: string): void {
    if (this.normalizedTrace.waterfall.aggregatedRootSpanIds.includes(spanId)) return;
    this.ensureAggregatedRootSpanIdsMutable();
    this.normalizedTrace.waterfall.aggregatedRootSpanIds.push(spanId);
  }

  getNormalizedTrace(): NormalizedTrace.Trace {
    return this.normalizedTrace;
  }

  private syncNodeStats(
    previousNode: NormalizedTrace.TraceNode | undefined,
    nextNode: NormalizedTrace.TraceNode,
  ): void {
    const previousEndTime = previousNode?.endTime;
    const nextEndTime = nextNode.endTime;

    if (previousNode === undefined) {
      if (nextEndTime === undefined) {
        this.activeNodesCount += 1;
      } else {
        this.maxEndTime = Math.max(this.maxEndTime, nextEndTime);
      }
    } else if (previousEndTime === undefined && nextEndTime !== undefined) {
      this.activeNodesCount -= 1;
      this.maxEndTime = Math.max(this.maxEndTime, nextEndTime);
    } else if (previousEndTime !== undefined && nextEndTime === undefined) {
      this.activeNodesCount += 1;
    } else if (
      nextEndTime !== undefined &&
      previousEndTime !== undefined &&
      nextEndTime > previousEndTime
    ) {
      this.maxEndTime = Math.max(this.maxEndTime, nextEndTime);
    }

    if (previousNode?.status === "error" && nextNode.status !== "error") {
      this.errorNodesCount -= 1;
    } else if (previousNode?.status !== "error" && nextNode.status === "error") {
      this.errorNodesCount += 1;
    }
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
