/**
 * Normalized generation detail nodes: generation:* — links to host via hostNodeId.
 */
import type { GenerationEndEvent, GenerationStartEvent, TraceEvent } from "@rejelly/core";
import type { ExecutionStatus, NormalizedTrace } from "../../../../types";
import type { EventHandler, TraceContext } from "../types";
import { attachDetailToHost } from "./normShared";

function endReasonToStatus(
  endReason: string | undefined,
  success: boolean | undefined,
): ExecutionStatus {
  if (endReason === "return") return "success";
  if (endReason === "error") return "error";
  if (endReason === "reborn") return "reborn";
  return success === false ? "error" : "success";
}

function coreGenerationName(generationId: number): string {
  return `Gen ${generationId}`;
}

export class NormGenerationHandler implements EventHandler {
  filter(event: TraceEvent): boolean {
    const t = event.type;
    return t === "generation:start" || t === "generation:end";
  }

  handle(event: TraceEvent, ctx: TraceContext): void {
    const t = event.type;
    if (t === "generation:start" || t === "generation:end") {
      this.handleCoreGeneration(event as GenerationStartEvent | GenerationEndEvent, ctx);
    }
  }

  private handleCoreGeneration(
    event: GenerationStartEvent | GenerationEndEvent,
    ctx: TraceContext,
  ): void {
    const norm = ctx.normalizedTrace;
    const spanId = event.trace.spanId;
    const parentSpanId = event.trace.parentSpanId;
    if (!parentSpanId) return;

    if (event.type === "generation:start") {
      const e = event as GenerationStartEvent;
      if (norm.nodeMap[spanId]) return;
      const node: NormalizedTrace.GenerationNode = {
        type: "generation",
        category: "detail",
        spanId,
        name: coreGenerationName(e.generationId),
        parentSpanId,
        hostNodeId: parentSpanId,
        mountedDetailIds: [],
        mountedStructuralIds: [],
        status: "running",
        startTime: e.timestamp,
        startEvent: e,
      };
      ctx.addNode(node);
      attachDetailToHost(ctx, parentSpanId, spanId);
      return;
    }

    const e = event as GenerationEndEvent;
    let node = norm.nodeMap[spanId];
    if (!node || node.type !== "generation") {
      const created: NormalizedTrace.GenerationNode = {
        type: "generation",
        category: "detail",
        spanId,
        name: coreGenerationName(e.generationId),
        parentSpanId,
        hostNodeId: parentSpanId,
        mountedDetailIds: [],
        mountedStructuralIds: [],
        status: endReasonToStatus(e.endReason, e.success),
        startTime: e.timestamp,
        startEvent: { ...e, type: "generation:start" } as GenerationStartEvent,
      };
      ctx.addNode(created);
      node = created;
      attachDetailToHost(ctx, parentSpanId, spanId);
    }

    ctx.updateNode<NormalizedTrace.GenerationNode>(spanId, (draft) => {
      draft.endEvent = e;
      draft.endTime = e.timestamp;
      draft.duration = e.duration;
      draft.status = endReasonToStatus(e.endReason, e.success);
    });
  }
}
