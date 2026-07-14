/**
 * Normalized structural nodes (sidebar tree): Agent, custom Span, RunWith — start/end/reborn.
 */
import type {
  AgentEndEvent,
  AgentRebornEvent,
  AgentStartEvent,
  CustomSpanEndEvent,
  CustomSpanStartEvent,
  RunWithEndEvent,
  RunWithStartEvent,
  TraceEvent,
} from "@rejelly/core";
import type { NormalizedTrace } from "../../../../types";
import type { EventHandler, TraceContext } from "../types";

export class NormStructuralHandler implements EventHandler {
  filter(event: TraceEvent): boolean {
    const t = event.type;
    if (t.startsWith("agent")) return true;
    if (t.startsWith("custom:span")) return true;
    if (t === "runWith:start" || t === "runWith:end") return true;
    return false;
  }

  handle(event: TraceEvent, ctx: TraceContext): void {
    const t = event.type;

    if (t.startsWith("agent")) {
      this.handleAgent(event as AgentStartEvent | AgentEndEvent | AgentRebornEvent, ctx);
      return;
    }
    if (t.startsWith("custom:span")) {
      this.handleCustomSpan(event as CustomSpanStartEvent | CustomSpanEndEvent, ctx);
      return;
    }
    if (t === "runWith:start" || t === "runWith:end") {
      this.handleRunWith(event as RunWithStartEvent | RunWithEndEvent, ctx);
    }
  }

  private handleAgent(
    event: AgentStartEvent | AgentEndEvent | AgentRebornEvent,
    ctx: TraceContext,
  ): void {
    const norm = ctx.normalizedTrace;
    const t = event.type;
    const spanId = event.trace.spanId;
    const parentSpanId =
      event.trace.parentSpanId != null && event.trace.parentSpanId !== ""
        ? event.trace.parentSpanId
        : undefined;

    if (t === "agent:start") {
      const e = event as AgentStartEvent;
      if (norm.nodeMap[spanId]) return;
      const node: NormalizedTrace.AgentNode = {
        type: "agent",
        category: "structural",
        spanId,
        name: String(e.agentId ?? "Unknown Agent"),
        parentSpanId,
        hostNodeId: undefined,
        mountedDetailIds: [],
        mountedStructuralIds: [],
        status: "running",
        startTime: e.timestamp,
        startEvent: e,
        rebornEvents: [],
      };
      ctx.addNode(node);
      ctx.setTraceStartTime(e.timestamp);
      return;
    }

    if (t === "agent:end") {
      const e = event as AgentEndEvent;
      const node = norm.nodeMap[spanId];
      if (!node || node.type !== "agent") return;
      ctx.updateNode<NormalizedTrace.AgentNode>(spanId, (draft) => {
        draft.endEvent = e;
        draft.endTime = e.timestamp;
        draft.duration = e.duration;
        draft.status = e.success === false ? "error" : "success";
      });
      return;
    }

    if (t === "agent:reborn") {
      const e = event as AgentRebornEvent;
      const node = norm.nodeMap[spanId];
      if (!node || node.type !== "agent") return;
      ctx.updateNode<NormalizedTrace.AgentNode>(spanId, (draft) => {
        draft.rebornEvents.push(e);
      });
    }
  }

  private handleCustomSpan(
    event: CustomSpanStartEvent | CustomSpanEndEvent,
    ctx: TraceContext,
  ): void {
    const norm = ctx.normalizedTrace;
    const t = event.type;
    const spanId = event.trace.spanId;
    const parentSpanId =
      event.trace.parentSpanId != null && event.trace.parentSpanId !== ""
        ? event.trace.parentSpanId
        : undefined;

    if (t === "custom:span:start") {
      const e = event as CustomSpanStartEvent;
      if (norm.nodeMap[spanId]) return;
      const node: NormalizedTrace.SpanNode = {
        type: "span",
        category: "structural",
        spanId,
        name: e.name,
        parentSpanId,
        hostNodeId: undefined,
        mountedDetailIds: [],
        mountedStructuralIds: [],
        status: "running",
        startTime: e.timestamp,
        startEvent: e,
      };
      ctx.addNode(node);
      ctx.setTraceStartTime(e.timestamp);
      return;
    }

    if (t === "custom:span:end") {
      const e = event as CustomSpanEndEvent;
      const node = norm.nodeMap[spanId];
      if (!node || node.type !== "span") return;
      ctx.updateNode<NormalizedTrace.SpanNode>(spanId, (draft) => {
        draft.endEvent = e;
        draft.endTime = e.timestamp;
        draft.duration = e.duration;
        draft.status = e.success === false ? "error" : "success";
      });
    }
  }

  private handleRunWith(event: RunWithStartEvent | RunWithEndEvent, ctx: TraceContext): void {
    const norm = ctx.normalizedTrace;
    const t = event.type;
    const spanId = event.trace.spanId;
    const parentSpanId =
      event.trace.parentSpanId != null && event.trace.parentSpanId !== ""
        ? event.trace.parentSpanId
        : undefined;

    if (t === "runWith:start") {
      const e = event as RunWithStartEvent;
      if (norm.nodeMap[spanId]) return;
      const node: NormalizedTrace.RunWithNode = {
        type: "runWith",
        category: "structural",
        spanId,
        name: "runWith",
        parentSpanId,
        hostNodeId: undefined,
        mountedDetailIds: [],
        mountedStructuralIds: [],
        status: "running",
        startTime: e.timestamp,
        startEvent: e,
      };
      ctx.addNode(node);
      ctx.setTraceStartTime(e.timestamp);
      return;
    }

    if (t === "runWith:end") {
      const e = event as RunWithEndEvent;
      const node = norm.nodeMap[spanId];
      if (!node || node.type !== "runWith") return;
      ctx.updateNode<NormalizedTrace.RunWithNode>(spanId, (draft) => {
        draft.endEvent = e;
        draft.endTime = e.timestamp;
        draft.duration = e.duration;
        draft.status = e.success === false ? "error" : "success";
      });
    }
  }
}
