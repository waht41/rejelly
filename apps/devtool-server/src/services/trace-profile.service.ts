import type { TraceEvent } from "@rejelly/core";
import { renderToolOutput } from "../utils/tool-output";
import { traceService } from "./trace.service";

type JsonRecord = Record<string, unknown>;

export interface TraceProfileSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  type: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  status: "running" | "success" | "error";
  depth: number;
  childCount: number;
}

export interface TraceProfileExecutionNode {
  ref: string;
  nodeId: string;
  parentNodeId: string | null;
  spanId: string;
  name: string;
  type: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  status: "running" | "success" | "error";
  kind: "span" | "event";
  eventSequence: number | null;
}

export interface TraceProfile {
  traceId: string;
  summary: {
    name: string | null;
    status: string | null;
    endReason: string | null;
    startTime: number | null;
    endTime: number | null;
    duration: number | null;
    eventCount: number;
    spanCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    llmCallCount: number;
    toolCallCount: number;
  };
  eventTypeCounts: Record<string, number>;
  llmCalls: Array<{
    spanId: string;
    parentSpanId: string | null;
    model: string | null;
    duration: number | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    finishReason: string | null;
    success: boolean | null;
  }>;
  toolExecutions: Array<{
    spanId: string;
    parentSpanId: string | null;
    toolNames: string[];
    duration: number | null;
    successCount: number | null;
    failureCount: number | null;
    success: boolean | null;
    calls: Array<{
      callId: string | null;
      toolName: string | null;
      duration: number | null;
      success: boolean | null;
      outputChars: number | null;
    }>;
  }>;
  waterfall: {
    rootSpanIds: string[];
    spans: TraceProfileSpan[];
    longestSpans: TraceProfileSpan[];
  };
  execution: {
    rootNodeIds: string[];
    nodes: TraceProfileExecutionNode[];
  };
  usageByModel: Record<string, unknown>;
  usageByTool: Record<string, unknown>;
  /** Merged entry-span attributes (runWith trace.attributes / equipTraceAttr). */
  rootAttributes: Record<string, unknown> | null;
}

interface MutableSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  type: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  status: "running" | "success" | "error";
  children: string[];
}

interface ExecutionPointEvent {
  event: TraceEvent;
  sequence: number;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function eventCategory(type: string): string {
  const base = type.split(":")[0];
  return base === "custom" ? "span" : base;
}

// Framework lifecycle events carry structured fields that beat the generic
// name/operation fallback: bare "Generation" hides which iteration it is, and
// resource ops would surface as just "create", dropping the resourceId.
function frameworkEventName(event: TraceEvent): string | null {
  const payload = event as unknown as JsonRecord;
  const base = event.type.replace(/:start$|:end$/, "");

  if (base === "generation") {
    const generationId = readNumber(payload.generationId);
    const label = generationId != null ? `Generation #${generationId}` : "Generation";
    return payload.endReason === "reborn" ? `${label} (reborn)` : label;
  }

  if (base === "agent:reborn") {
    const endedGenerationId = readNumber(payload.generationId);
    return endedGenerationId != null
      ? `Agent Reborn → gen ${endedGenerationId + 1}`
      : "Agent Reborn";
  }

  if (base === "resource:op") {
    const parts = ["Resource Op", readString(payload.operation), readString(payload.resourceId)];
    const label = parts.filter((part) => part != null).join(" ");
    return payload.reused === true ? `${label} (reused)` : label;
  }

  if (base === "instrument:op") {
    const name = readString(payload.name);
    const operation = readString(payload.operation);
    if (name && operation) return `${name}.${operation}`;
  }

  return null;
}

function displayName(event: TraceEvent): string {
  const payload = event as unknown as JsonRecord;
  const frameworkName = frameworkEventName(event);
  if (frameworkName) return frameworkName;
  const explicitName =
    readString(payload.name) ?? readString(payload.operation) ?? readString(payload.resourceId);
  if (explicitName) return explicitName;
  return event.type
    .replace(/:start$|:end$/, "")
    .replace(/[:.]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isStartEvent(type: string): boolean {
  return type.endsWith(":start");
}

function isEndEvent(type: string): boolean {
  return type.endsWith(":end");
}

function isExecutionPointEvent(type: string): boolean {
  return !isStartEvent(type) && !isEndEvent(type);
}

function eventStatus(event: TraceEvent): "running" | "success" | "error" {
  const payload = event as unknown as JsonRecord;
  if (event.type === "error" || payload.success === false) {
    return "error";
  }
  if (payload.success === true || isExecutionPointEvent(event.type)) {
    return "success";
  }
  return "running";
}

function getUsageTokens(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const u = asRecord(usage);
  const promptTokens = readNumber(u.promptTokens) ?? readNumber(u.prompt_tokens) ?? 0;
  const completionTokens = readNumber(u.completionTokens) ?? readNumber(u.completion_tokens) ?? 0;
  const totalTokens = readNumber(u.totalTokens) ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function normalizeSpan(event: TraceEvent, existing?: MutableSpan): MutableSpan {
  const payload = event as unknown as JsonRecord;
  const duration = readNumber(payload.duration);
  const endTime = duration == null ? null : event.timestamp;
  const status =
    "success" in payload && payload.success === false
      ? "error"
      : isEndEvent(event.type)
        ? "success"
        : "running";

  return {
    spanId: event.trace.spanId,
    parentSpanId: event.trace.parentSpanId ?? null,
    // End events extend their start payload with outcome fields (endReason,
    // reused), so recompute the name instead of keeping the start-time one.
    name: isEndEvent(event.type) ? displayName(event) : (existing?.name ?? displayName(event)),
    type: existing?.type ?? eventCategory(event.type),
    startTime: existing?.startTime ?? event.timestamp,
    endTime: endTime ?? existing?.endTime ?? null,
    duration: duration ?? existing?.duration ?? null,
    status,
    children: existing?.children ?? [],
  };
}

function buildDepths(spans: Map<string, MutableSpan>, rootSpanIds: string[]): Map<string, number> {
  const depths = new Map<string, number>();

  function visit(spanId: string, depth: number) {
    if (depths.has(spanId)) return;
    depths.set(spanId, depth);
    const span = spans.get(spanId);
    if (!span) return;
    for (const childId of span.children) {
      visit(childId, depth + 1);
    }
  }

  for (const rootSpanId of rootSpanIds) {
    visit(rootSpanId, 0);
  }
  for (const spanId of spans.keys()) {
    if (!depths.has(spanId)) visit(spanId, 0);
  }

  return depths;
}

export async function getTraceProfile(traceId: string): Promise<TraceProfile> {
  const [events, detail] = await Promise.all([
    traceService.getTraceEvents(traceId),
    traceService.getTraceDetail(traceId),
  ]);

  const spans = new Map<string, MutableSpan>();
  const eventTypeCounts: Record<string, number> = {};
  const llmCalls: TraceProfile["llmCalls"] = [];
  const toolExecutions: TraceProfile["toolExecutions"] = [];
  const executionPointEvents: ExecutionPointEvent[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  for (const [sequence, event] of events.entries()) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;

    const spanId = event.trace?.spanId;
    if (spanId) {
      const existing = spans.get(spanId);
      if (isStartEvent(event.type)) {
        spans.set(spanId, normalizeSpan(event, existing));
      } else if (existing || isEndEvent(event.type)) {
        spans.set(spanId, normalizeSpan(event, existing));
      }
    }

    if (isExecutionPointEvent(event.type)) {
      executionPointEvents.push({ event, sequence });
    }

    const payload = event as unknown as JsonRecord;
    if (event.type === "model:call:end") {
      const usage = getUsageTokens(payload.usage);
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      llmCalls.push({
        spanId: event.trace.spanId,
        parentSpanId: event.trace.parentSpanId ?? null,
        model: readString(payload.id) ?? readString(payload.provider),
        duration: readNumber(payload.duration),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        finishReason: readString(payload.finishReason),
        success: typeof payload.success === "boolean" ? payload.success : null,
      });
    }

    if (event.type === "tools:execute:end") {
      const toolNames = Array.isArray(payload.toolNames)
        ? payload.toolNames.filter((name): name is string => typeof name === "string")
        : [];
      const toolResults = Array.isArray(payload.toolResults) ? payload.toolResults : [];
      const calls = toolResults.map((result) => {
        const record = asRecord(result);
        return {
          callId: readString(record.callId),
          toolName: readString(record.toolName),
          duration: readNumber(record.duration),
          success: typeof record.success === "boolean" ? record.success : null,
          outputChars: renderToolOutput(record.output).length,
        };
      });
      toolExecutions.push({
        spanId: event.trace.spanId,
        parentSpanId: event.trace.parentSpanId ?? null,
        toolNames,
        duration: readNumber(payload.duration),
        successCount: readNumber(payload.successCount),
        failureCount: readNumber(payload.failureCount),
        success: typeof payload.success === "boolean" ? payload.success : null,
        calls,
      });
    }
  }

  for (const span of spans.values()) {
    if (!span.parentSpanId) continue;
    const parent = spans.get(span.parentSpanId);
    if (parent && !parent.children.includes(span.spanId)) {
      parent.children.push(span.spanId);
    }
  }

  const rootSpanIds = [...spans.values()]
    .filter((span) => !span.parentSpanId || !spans.has(span.parentSpanId))
    .sort((a, b) => a.startTime - b.startTime)
    .map((span) => span.spanId);
  const depths = buildDepths(spans, rootSpanIds);
  const profileSpans = [...spans.values()]
    .sort((a, b) => a.startTime - b.startTime)
    .map((span) => ({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      type: span.type,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      status: span.status,
      depth: depths.get(span.spanId) ?? 0,
      childCount: span.children.length,
    }));

  const longestSpans = [...profileSpans]
    .filter((span) => span.duration != null)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, 10);

  const executionNodes: TraceProfileExecutionNode[] = [
    ...profileSpans.map((span) => ({
      ref: "",
      nodeId: span.spanId,
      parentNodeId: span.parentSpanId,
      spanId: span.spanId,
      name: span.name,
      type: span.type,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      status: span.status,
      kind: "span" as const,
      eventSequence: null,
    })),
    ...executionPointEvents.map(({ event, sequence }) => {
      const spanId = event.trace.spanId;
      const parentNodeId = event.trace.parentSpanId ?? (spans.has(spanId) ? spanId : null);
      return {
        ref: "",
        nodeId: `${event.type}:${spanId}:${event.timestamp}:${sequence}`,
        parentNodeId,
        spanId,
        name: displayName(event),
        type: event.type,
        startTime: event.timestamp,
        endTime: null,
        duration: null,
        status: eventStatus(event),
        kind: "event" as const,
        eventSequence: sequence,
      };
    }),
  ].sort((a, b) => a.startTime - b.startTime);

  const executionNodeIds = new Set(executionNodes.map((node) => node.nodeId));
  const executionRootNodeIds = executionNodes
    .filter((node) => !node.parentNodeId || !executionNodeIds.has(node.parentNodeId))
    .sort((a, b) => a.startTime - b.startTime)
    .map((node) => node.nodeId);
  const executionNodesById = new Map(executionNodes.map((node) => [node.nodeId, node]));
  const executionChildrenByParent = new Map<string | null, TraceProfileExecutionNode[]>();
  for (const node of executionNodes) {
    const siblings = executionChildrenByParent.get(node.parentNodeId) ?? [];
    siblings.push(node);
    executionChildrenByParent.set(node.parentNodeId, siblings);
  }

  let nextNodeRef = 1;
  const referencedNodeIds = new Set<string>();
  function assignNodeRefs(node: TraceProfileExecutionNode) {
    if (referencedNodeIds.has(node.nodeId)) return;
    referencedNodeIds.add(node.nodeId);
    node.ref = `n${nextNodeRef}`;
    nextNodeRef += 1;

    const children = [...(executionChildrenByParent.get(node.nodeId) ?? [])].sort(
      (a, b) => a.startTime - b.startTime,
    );
    for (const child of children) {
      assignNodeRefs(child);
    }
  }

  for (const rootNodeId of executionRootNodeIds) {
    const rootNode = executionNodesById.get(rootNodeId);
    if (rootNode) assignNodeRefs(rootNode);
  }
  for (const node of executionNodes) {
    if (!node.ref) assignNodeRefs(node);
  }

  return {
    traceId,
    summary: {
      name: detail?.name ?? null,
      status: detail?.status ?? null,
      endReason: detail?.endReason ?? null,
      startTime: detail?.timestamp ?? events[0]?.timestamp ?? null,
      endTime:
        detail?.timestamp != null && detail.duration != null
          ? detail.timestamp + detail.duration
          : null,
      duration: detail?.duration ?? null,
      eventCount: events.length,
      spanCount: spans.size,
      totalTokens: detail?.totalTokens ?? promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      llmCallCount: detail?.llmCallCount ?? llmCalls.length,
      toolCallCount: detail?.toolCallCount ?? toolExecutions.length,
    },
    eventTypeCounts,
    llmCalls,
    toolExecutions,
    waterfall: {
      rootSpanIds,
      spans: profileSpans,
      longestSpans,
    },
    execution: {
      rootNodeIds: executionRootNodeIds,
      nodes: executionNodes,
    },
    usageByModel: parseJsonRecord(detail?.llmUsage),
    usageByTool: parseJsonRecord(detail?.toolUsage),
    rootAttributes: detail?.attributes ?? null,
  };
}
