/**
 * Normalized update log: append raw TraceEvent[] per span for promptAgent / turn / attempt / validation / errors.
 */
import type { TraceEvent } from "@rejelly/core";
import type { ExecutionStatus, NormalizedTrace } from "../../../../types";
import { EVENTS } from "../../../traceEventConstants";
import type { EventHandler, TraceContext } from "../types";
import {
  appendLogSummary,
  attachDetailToHost,
  copyTraceEvent,
  findHostNodeIdForDetail,
} from "./normShared";

function initialUpdateStatus(event: TraceEvent): ExecutionStatus {
  const t = event.type;
  if (t.endsWith(":reborn")) return "reborn";
  if (t === "error" || t === "validation:fail") return "error";
  if (t.endsWith(":end") || t === "validation:success") return "success";
  if (t.endsWith(":start")) return "running";
  return "running";
}

function refineStatusAfterEvent(event: TraceEvent, prev: ExecutionStatus): ExecutionStatus {
  const t = event.type;
  if (t.endsWith(":reborn")) return "reborn";
  if (t === "error" || t === "validation:fail") return "error";
  if (t.endsWith(":end") || t === "validation:success") return "success";
  if (t.endsWith(":start")) return "running";
  return prev;
}

function getSysLogLevel(event: TraceEvent): NormalizedTrace.LogLevel | undefined {
  if (event.type !== EVENTS.SYS_LOG) return undefined;
  const level = (event as unknown as { level?: unknown }).level;
  if (level === "debug" || level === "info" || level === "warning" || level === "error") {
    return level;
  }
  return undefined;
}

type TraceEventWithSeq = TraceEvent & { _seq?: number };

/**
 * Idempotent append: duplicate delivery shares the same event identity.
 * Events without `_seq` or without `trace.spanId` skip dedup (local sources).
 */
function isDuplicateUpdateEvent(events: readonly TraceEvent[], event: TraceEvent): boolean {
  const seq = (event as TraceEventWithSeq)._seq;
  const spanId = event.trace?.spanId;
  if (seq === undefined || spanId == null || spanId === "") return false;
  return events.some((e) => {
    const existingSeq = (e as TraceEventWithSeq)._seq;
    const existingSpanId = e.trace?.spanId;
    return (
      existingSeq === seq &&
      existingSpanId === spanId &&
      e.timestamp === event.timestamp &&
      e.type === event.type
    );
  });
}

export class NormUpdateLogHandler implements EventHandler {
  filter(event: TraceEvent): boolean {
    const type = event.type;
    return (
      !type.startsWith("generation") &&
      (!type.startsWith("agent") || type === "agent:reborn") &&
      !type.startsWith("custom:span") &&
      !type.startsWith("span") &&
      type !== "runWith:start" &&
      type !== "runWith:end"
    );
  }

  handle(event: TraceEvent, ctx: TraceContext): void {
    const { trace, timestamp } = event;
    const spanId = trace.spanId;
    const parentSpanId = trace.parentSpanId;

    const sysLogLevel = getSysLogLevel(event);
    if (sysLogLevel) {
      const node = ctx.normalizedTrace.nodeMap[spanId];
      if (!node) return;
      if (node.type === "update" && isDuplicateUpdateEvent(node.events, event)) {
        return;
      }
      ctx.updateNode<NormalizedTrace.TraceNode>(spanId, (draft) => {
        appendLogSummary(draft, sysLogLevel, event);
        if (draft.type === "update") {
          draft.events.push(copyTraceEvent(event));
        }
      });
      return;
    }

    if (!parentSpanId) return;

    const resolveAndAttachHost = (updateSpanId: string): void => {
      const current = ctx.normalizedTrace.nodeMap[updateSpanId];
      if (!current || current.type !== "update") return;
      const resolvedHostId = findHostNodeIdForDetail(ctx.normalizedTrace, current.parentSpanId);
      if (!resolvedHostId || !ctx.normalizedTrace.nodeMap[resolvedHostId]) return;
      ctx.updateNode<NormalizedTrace.UpdateNode>(updateSpanId, (draft) => {
        draft.hostNodeId = resolvedHostId;
      });
      attachDetailToHost(ctx, resolvedHostId, updateSpanId);
    };

    const node = ctx.normalizedTrace.nodeMap[spanId];
    if (!node || node.type !== "update") {
      const update: NormalizedTrace.UpdateNode = {
        type: "update",
        category: "detail",
        spanId,
        name: event.type,
        parentSpanId,
        hostNodeId: undefined,
        mountedDetailIds: [],
        mountedStructuralIds: [],
        status: initialUpdateStatus(event),
        startTime: timestamp,
        events: [],
      };
      ctx.traceLinker.registerNode(update, parentSpanId, () => {
        resolveAndAttachHost(update.spanId);
      });
      resolveAndAttachHost(update.spanId);
    }

    const u = ctx.normalizedTrace.nodeMap[spanId] as NormalizedTrace.UpdateNode;
    if (isDuplicateUpdateEvent(u.events, event)) {
      return;
    }
    ctx.updateNode<NormalizedTrace.UpdateNode>(spanId, (draft) => {
      draft.events.push(copyTraceEvent(event));
      draft.status = refineStatusAfterEvent(event, draft.status);

      if (event.type.endsWith(":end") || event.type === "validation:success") {
        draft.endTime = timestamp;
        draft.duration = timestamp - draft.startTime;
      } else if (event.type === "error" || event.type === "validation:fail") {
        draft.endTime = timestamp;
        draft.duration = timestamp - draft.startTime;
      } else if (event.type.endsWith(":reborn")) {
        draft.endTime = timestamp;
        draft.duration = timestamp - draft.startTime;
      }
    });
  }
}
