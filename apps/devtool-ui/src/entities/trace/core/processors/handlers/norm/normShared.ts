/**
 * Shared helpers for normalized trace dual-write handlers.
 */
import type { TraceEvent } from "@rejelly/core";
import type { ErrorInfo, NormalizedTrace } from "../../../../types";
import { EVENTS } from "../../../traceEventConstants";
import type { TraceContext } from "../types";

export function copyTraceEvent(event: TraceEvent): TraceEvent {
  return { ...event, trace: event.trace ? { ...event.trace } : undefined } as TraceEvent;
}

function eventCategory(type: string): string {
  const base = type.split(":")[0];
  if (base === "custom") return "span";
  return base;
}

function displayName(type: string, payload: Record<string, unknown>): string {
  if (typeof payload.name === "string" && payload.name) return payload.name;
  const suffix = type.replace(/:start$|:end$/, "");
  return suffix.replace(/[:.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isStartType(type: string): boolean {
  return type.endsWith(":start");
}

function isEndType(type: string): boolean {
  return type.endsWith(":end");
}

/**
 * Point-in-time events: type is neither *:start nor *:end (own spanId, no start/end pair).
 * Linked under trace.parentSpanId when the span row is first seen.
 */
function isWaterfallPointEventType(type: string): boolean {
  return !isStartType(type) && !isEndType(type);
}

const LOG_LEVEL_RANK: Record<NormalizedTrace.LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

function getSysLogLevel(event: TraceEvent): NormalizedTrace.LogLevel | undefined {
  if (event.type !== EVENTS.SYS_LOG) return undefined;
  const level = (event as unknown as { level?: unknown }).level;
  if (level === "debug" || level === "info" || level === "warning" || level === "error") {
    return level;
  }
  return undefined;
}

export function appendLogSummary(
  target: Pick<NormalizedTrace.AggregatedSpan, "logCount" | "maxLogLevel" | "logEvents">,
  level: NormalizedTrace.LogLevel,
  event?: TraceEvent,
): void {
  if (event) {
    const key = getLogEventKey(event);
    const exists = (target.logEvents ?? []).some((logEvent) => getLogEventKey(logEvent) === key);
    if (exists) return;
  }

  target.logCount = (target.logCount ?? 0) + 1;
  if (!target.maxLogLevel || LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[target.maxLogLevel]) {
    target.maxLogLevel = level;
  }
  if (event) {
    target.logEvents = [...(target.logEvents ?? []), copyTraceEvent(event)];
  }
}

function getLogEventKey(event: TraceEvent): string {
  const payload = event as TraceEvent & {
    _seq?: number;
    level?: unknown;
    message?: unknown;
    args?: unknown;
  };
  return [
    payload._seq ?? "",
    event.timestamp,
    event.trace?.spanId ?? "",
    event.type,
    payload.level ?? "",
    payload.message ?? "",
    safeStringify(payload.args),
  ].join("|");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Merge rules for NormalizedTrace.waterfall aggregated spans.
 */
export function mergeEventIntoWaterfall(ctx: TraceContext, event: TraceEvent): void {
  const spanId = event.trace?.spanId;
  if (spanId == null || spanId === "") return;

  const { type, timestamp } = event;
  const payload = event as unknown as Record<string, unknown>;
  const waterfall = ctx.normalizedTrace.waterfall;
  const map = waterfall.aggregatedSpans;

  const sysLogLevel = getSysLogLevel(event);
  if (sysLogLevel) {
    const host = map.get(spanId);
    if (host) {
      ctx.updateAggregatedSpan(spanId, (draft) => {
        appendLogSummary(draft, sysLogLevel, event);
      });
    }
    return;
  }

  if (isStartType(type)) {
    if (map.has(spanId)) return;

    const parentSpanId =
      event.trace?.parentSpanId != null && event.trace.parentSpanId !== ""
        ? event.trace.parentSpanId
        : undefined;

    const node: NormalizedTrace.AggregatedSpan = {
      id: spanId,
      parentId: parentSpanId,
      name: displayName(type, payload),
      type: eventCategory(type),
      timestamp,
      status: "running",
      detail: copyTraceEvent(event),
      childrenIds: [],
    };

    ctx.upsertAggregatedSpan(node);

    if (parentSpanId == null) {
      ctx.addAggregatedRootSpanId(spanId);
    } else {
      const parent = map.get(parentSpanId);
      if (parent) {
        ctx.updateAggregatedSpan(parentSpanId, (draft) => {
          if (!draft.childrenIds.includes(spanId)) {
            draft.childrenIds.push(spanId);
          }
        });
      }
    }
    return;
  }

  const node = map.get(spanId);
  if (!node && isWaterfallPointEventType(type)) {
    const parentSpanId =
      event.trace?.parentSpanId != null && event.trace.parentSpanId !== ""
        ? event.trace.parentSpanId
        : undefined;
    if (!parentSpanId) return;

    const failed =
      type === "validation:fail" || ("success" in payload && payload.success === false);
    const status: NormalizedTrace.AggregatedSpan["status"] = failed ? "error" : "success";
    const pointNode: NormalizedTrace.AggregatedSpan = {
      id: spanId,
      parentId: parentSpanId,
      name: displayName(type, payload),
      type: eventCategory(type),
      timestamp,
      duration: 0,
      status,
      detail: copyTraceEvent(event),
      childrenIds: [],
    };
    if (failed && payload.error != null) {
      pointNode.error = payload.error as ErrorInfo;
    }
    ctx.upsertAggregatedSpan(pointNode);
    const parent = map.get(parentSpanId);
    if (parent && !parent.childrenIds.includes(spanId)) {
      ctx.updateAggregatedSpan(parentSpanId, (draft) => {
        if (!draft.childrenIds.includes(spanId)) {
          draft.childrenIds.push(spanId);
        }
      });
    }
    return;
  }

  if (!node) return;
  if (!isEndType(type)) return;

  ctx.updateAggregatedSpan(spanId, (draft) => {
    draft.detail = copyTraceEvent(event);

    if ("duration" in payload && typeof payload.duration === "number") {
      draft.duration = payload.duration;
    } else {
      draft.duration = timestamp - draft.timestamp;
    }

    if ("success" in payload && payload.success === false) {
      draft.status = "error";
      if (payload.error != null) {
        draft.error = payload.error as ErrorInfo;
      }
    } else {
      draft.status = "success";
      delete draft.error;
    }
  });
}

/** Link aggregated spans whose parent appeared after the child (same as TraceProcessor.linkAggregatedOrphans). */
export function linkWaterfallOrphans(ctx: TraceContext): void {
  const map = ctx.normalizedTrace.waterfall.aggregatedSpans;
  for (const span of map.values()) {
    if (!span.parentId) continue;
    const parent = map.get(span.parentId);
    if (!parent || parent.childrenIds.includes(span.id)) continue;
    ctx.updateAggregatedSpan(parent.id, (draft) => {
      if (!draft.childrenIds.includes(span.id)) {
        draft.childrenIds.push(span.id);
      }
    });
  }
}

/**
 * Walk parentSpanId until a structural node is found (skips detail nodes in between).
 */
export function resolveStructuralParentId(
  norm: NormalizedTrace.Trace,
  parentSpanId: string | undefined,
): string | undefined {
  if (!parentSpanId) return undefined;
  let id: string | undefined = parentSpanId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = norm.nodeMap[id];
    if (!n) return undefined;
    if (n.category === "structural") return id;
    id = n.parentSpanId;
  }
  return undefined;
}

/**
 * Rebuild structuralRootIds and each structural node's mountedStructuralIds from parentSpanId.
 * Call once per batch after all nodes exist (fixes late parents + idempotent ingest).
 */
export function rebuildStructuralTopology(ctx: TraceContext): void {
  const norm = ctx.normalizedTrace;
  const nextRootIds: string[] = [];
  const nextChildrenByParent = new Map<string, string[]>();

  const structuralNodes = Object.values(norm.nodeMap).filter(
    (n): n is NormalizedTrace.SpanNode | NormalizedTrace.AgentNode | NormalizedTrace.RunWithNode =>
      n.category === "structural",
  );

  for (const n of structuralNodes) {
    nextChildrenByParent.set(n.spanId, []);
  }

  for (const n of structuralNodes) {
    const parentId = resolveStructuralParentId(norm, n.parentSpanId);
    if (parentId) {
      const parent = norm.nodeMap[parentId];
      if (parent?.category === "structural") {
        nextChildrenByParent.get(parentId)?.push(n.spanId);
      }
    } else if (!nextRootIds.includes(n.spanId)) {
      nextRootIds.push(n.spanId);
    }
  }

  ctx.replaceStructuralRootIds(nextRootIds);

  for (const n of structuralNodes) {
    const nextChildren = [...(nextChildrenByParent.get(n.spanId) ?? [])].sort((a, b) => {
      const na = norm.nodeMap[a];
      const nb = norm.nodeMap[b];
      return (na?.startTime ?? 0) - (nb?.startTime ?? 0);
    });
    ctx.replaceMountedStructuralIds(n.spanId, nextChildren);
  }
}

/** Append a detail span id to a host structural or generation node. */
export function attachDetailToHost(
  ctx: TraceContext,
  hostSpanId: string,
  detailSpanId: string,
): void {
  const host = ctx.normalizedTrace.nodeMap[hostSpanId];
  if (!host) return;
  if (!host.mountedDetailIds.includes(detailSpanId)) {
    ctx.appendMountedDetailId(hostSpanId, detailSpanId);
  }
}

/**
 * Walk parents until we hit a generation or structural node to use as hostNodeId.
 */
export function findHostNodeIdForDetail(
  norm: NormalizedTrace.Trace,
  startParentId: string | undefined,
): string | undefined {
  let id: string | undefined = startParentId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = norm.nodeMap[id];
    if (!n) return id;
    if (n.type === "generation") return id;
    if (n.category === "structural") return id;
    id = n.parentSpanId;
  }
  return undefined;
}
