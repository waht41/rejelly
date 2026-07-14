/**
 * Normalized trace model: flat nodeMap + dual pointers (parentSpanId + hostNodeId).
 * Nodes are topology containers; business payloads live on raw @rejelly/core events (zero mapping loss).
 * Built by TraceProcessor from raw TraceEvent batches.
 */
import type {
  AgentEndEvent,
  AgentRebornEvent,
  AgentStartEvent,
  CustomSpanEndEvent,
  CustomSpanStartEvent,
  GenerationEndEvent,
  GenerationStartEvent,
  RunWithEndEvent,
  RunWithStartEvent,
  TraceEvent,
} from "@rejelly/core";
import type { ErrorInfo, ExecutionStatus } from "./index.ts";

/**
 * UI partition: sidebar tree vs right-panel detail (timeline, execution, etc.).
 */
export type NodeCategory = "structural" | "detail";

export type LogLevel = "debug" | "info" | "warning" | "error";

/**
 * Structural index + timeline fields only. Payloads are on typed events per node kind.
 */
export interface BaseNode {
  spanId: string;
  /** Sidebar / header label (filled at ingest from raw events). */
  name: string;
  /** Optional UI hints; keep small. */
  metadata?: Record<string, unknown>;
  parentSpanId?: string;
  hostNodeId?: string;
  category: NodeCategory;
  /**
   * Detail-only children (generations, updates, …) mounted under this node.
   * Structural hosts use this for timeline/detail; detail nodes may nest further detail ids.
   */
  mountedDetailIds: string[];
  /**
   * Structural-only children for the sidebar tree (ingest-maintained).
   * Detail nodes keep this empty — structural topology does not attach through detail layers.
   */
  mountedStructuralIds: string[];
  status: ExecutionStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  logCount?: number;
  maxLogLevel?: LogLevel;
  logEvents?: TraceEvent[];
}

/**
 * Custom trace() / withCustomSpan span — payload from custom:span:start / custom:span:end.
 */
export interface SpanNode extends BaseNode {
  type: "span";
  category: "structural";
  startEvent: CustomSpanStartEvent;
  endEvent?: CustomSpanEndEvent;
}

/**
 * Agent lifecycle — payload from agent:start, agent:end, agent:reborn.
 */
export interface AgentNode extends BaseNode {
  type: "agent";
  category: "structural";
  startEvent: AgentStartEvent;
  endEvent?: AgentEndEvent;
  rebornEvents: AgentRebornEvent[];
}

/**
 * Root runWith — payload from runWith:start / runWith:end.
 */
export interface RunWithNode extends BaseNode {
  type: "runWith";
  category: "structural";
  startEvent: RunWithStartEvent;
  endEvent?: RunWithEndEvent;
}

/**
 * LLM generation — payload from generation:start / generation:end.
 */
export interface GenerationNode extends BaseNode {
  type: "generation";
  category: "detail";
  startEvent: GenerationStartEvent;
  endEvent?: GenerationEndEvent;
}

/**
 * Instant or multi-fire updates (validation, turn/attempt fragments, etc.) — append-only event log.
 */
export interface UpdateNode extends BaseNode {
  type: "update";
  category: "detail";
  /** Chronological raw events for this span (e.g. validation:fail, error, or batched trace lines). */
  events: TraceEvent[];
}

export type TraceNode = SpanNode | AgentNode | RunWithNode | GenerationNode | UpdateNode;

export type SideTreeNode = SpanNode | AgentNode | RunWithNode;

/**
 * Single source of truth: no sideTree, spanTree, or agentGenLookup on the root.
 */
export interface Trace {
  id: string;
  name?: string;
  nodeMap: Record<string, TraceNode>;
  structuralRootIds: string[];
  /** Merged Start/End spans for waterfall UI (same shape as legacy SpanTree). */
  waterfall: Waterfall;
  startTime: number;
  endTime?: number;
  status: ExecutionStatus;
  metadata?: Record<string, unknown>;
}

/**
 * Optional Jaeger-style aggregated spans (same idea as current SpanTree), separate from Trace root.
 */
export interface AggregatedSpan {
  id: string;
  parentId?: string;
  name: string;
  type: string;
  timestamp: number;
  duration?: number;
  status: "running" | "success" | "error";
  /** Latest merged payload; End overwrites Start when present. */
  detail?: TraceEvent;
  error?: ErrorInfo;
  childrenIds: string[];
  logCount?: number;
  maxLogLevel?: LogLevel;
  logEvents?: TraceEvent[];
}

/**
 * Aggregated span index for waterfall / Gantt view (O(1) by spanId, tree via childrenIds + roots).
 * Parallel to nodeMap: topology + timing for OTLP-style strips; payloads may mirror node events.
 */
export interface Waterfall {
  aggregatedSpans: Map<string, AggregatedSpan>;
  aggregatedRootSpanIds: string[];
}
