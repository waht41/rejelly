import { EVENTS, type TraceEvent } from "@rejelly/core";
import { traceService } from "../../../services/trace.service";
import {
  getTraceProfile,
  type TraceProfile,
  type TraceProfileExecutionNode,
} from "../../../services/trace-profile.service";
import { renderToolOutput } from "../../../utils/tool-output";

type TraceEventByType<K extends TraceEvent["type"]> = Extract<TraceEvent, { type: K }>;

/** One tool call flattened out of a tools:execute:end event. */
export interface ToolCallRecord {
  /** 1-based order of this call within the trace */
  ordinal: number;
  callId: string;
  toolName: string;
  input: unknown;
  /** String view of the tool output, derived from the event's `output` via renderToolOutput. */
  rawOutput: string;
  duration: number | null;
  success: boolean | null;
  error: unknown;
  cache: boolean | undefined;
  spanId: string;
  nodeRef: string | undefined;
}

/** Successful calls with output below this length are flagged as degraded. */
export const DEGRADED_OUTPUT_CHARS = 200;

export function isDegradedToolCall(call: Pick<ToolCallRecord, "success" | "rawOutput">): boolean {
  return call.success === true && call.rawOutput.length < DEGRADED_OUTPUT_CHARS;
}

export function normalizeNodeRef(ref: string): string {
  return ref.trim().replace(/^\[/, "").replace(/\]$/, "");
}

export function normalizeNodeRefs(
  nodeRef: string | string[] | undefined,
): Array<string | undefined> {
  if (nodeRef === undefined) return [undefined];
  if (Array.isArray(nodeRef)) return nodeRef;
  return nodeRef
    .split(/[,\s]+/)
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
}

export function isEvent<K extends TraceEvent["type"]>(
  event: TraceEvent,
  type: K,
): event is TraceEventByType<K> {
  return event.type === type;
}

export class TraceQuery {
  private _nodesByRef?: Map<string, TraceProfileExecutionNode>;
  private _nodesById?: Map<string, TraceProfileExecutionNode>;
  private _refBySpanId?: Map<string, string>;
  private _refByEventSequence?: Map<number, string>;
  private _childrenByParent?: Map<string | null, TraceProfileExecutionNode[]>;
  private _eventsBySpanId?: Map<string, TraceEvent[]>;
  private _toolCalls?: ToolCallRecord[];

  private constructor(
    readonly traceId: string,
    readonly profile: TraceProfile,
    readonly events: TraceEvent[],
  ) {}

  static async load(traceId: string): Promise<TraceQuery> {
    const [events, profile] = await Promise.all([
      traceService.getTraceEvents(traceId),
      getTraceProfile(traceId),
    ]);
    return new TraceQuery(traceId, profile, events);
  }

  static fromProfile(profile: TraceProfile, events: TraceEvent[] = []): TraceQuery {
    return new TraceQuery(profile.traceId, profile, events);
  }

  get nodesByRef(): Map<string, TraceProfileExecutionNode> {
    this._nodesByRef ??= new Map(this.profile.execution.nodes.map((node) => [node.ref, node]));
    return this._nodesByRef;
  }

  get nodesById(): Map<string, TraceProfileExecutionNode> {
    this._nodesById ??= new Map(this.profile.execution.nodes.map((node) => [node.nodeId, node]));
    return this._nodesById;
  }

  get refBySpanId(): Map<string, string> {
    this._refBySpanId ??= new Map(
      this.profile.execution.nodes.map((node) => [node.spanId, node.ref]),
    );
    return this._refBySpanId;
  }

  get refByEventSequence(): Map<number, string> {
    this._refByEventSequence ??= new Map(
      this.profile.execution.nodes
        .filter((node) => node.eventSequence != null)
        .map((node) => [node.eventSequence as number, node.ref]),
    );
    return this._refByEventSequence;
  }

  get toolCalls(): ToolCallRecord[] {
    if (!this._toolCalls) {
      const records: ToolCallRecord[] = [];
      for (const event of this.events) {
        if (!isEvent(event, EVENTS.TOOLS_EXECUTE_END)) continue;
        for (const result of event.toolResults) {
          records.push({
            ordinal: records.length + 1,
            callId: result.callId,
            toolName: result.toolName,
            input: result.input,
            rawOutput: renderToolOutput(result.output),
            duration: result.duration ?? null,
            success: result.success ?? null,
            error: result.error,
            cache: result.cache,
            spanId: event.trace.spanId,
            nodeRef: this.refBySpanId.get(event.trace.spanId),
          });
        }
      }
      this._toolCalls = records;
    }
    return this._toolCalls;
  }

  get childrenByParent(): Map<string | null, TraceProfileExecutionNode[]> {
    if (!this._childrenByParent) {
      const children = new Map<string | null, TraceProfileExecutionNode[]>();
      for (const node of this.profile.execution.nodes) {
        const siblings = children.get(node.parentNodeId) ?? [];
        siblings.push(node);
        children.set(node.parentNodeId, siblings);
      }
      for (const siblings of children.values()) {
        siblings.sort((a, b) => a.startTime - b.startTime);
      }
      this._childrenByParent = children;
    }
    return this._childrenByParent;
  }

  get eventsBySpanId(): Map<string, TraceEvent[]> {
    if (!this._eventsBySpanId) {
      const eventsBySpanId = new Map<string, TraceEvent[]>();
      for (const event of this.events) {
        const events = eventsBySpanId.get(event.trace.spanId) ?? [];
        events.push(event);
        eventsBySpanId.set(event.trace.spanId, events);
      }
      this._eventsBySpanId = eventsBySpanId;
    }
    return this._eventsBySpanId;
  }

  findNode(ref: string): TraceProfileExecutionNode | undefined {
    return this.nodesByRef.get(normalizeNodeRef(ref));
  }

  /** Resolve the execution node ref for an event by its sequence, falling back to its span. */
  refForEvent(sequence: number, spanId: string): string | undefined {
    return this.refByEventSequence.get(sequence) ?? this.refBySpanId.get(spanId);
  }

  lastTurn(): TraceProfileExecutionNode | undefined {
    return [...this.profile.execution.nodes]
      .filter((node) => node.type === "turn")
      .sort((a, b) => b.startTime - a.startTime)[0];
  }

  directChildren(node: TraceProfileExecutionNode): TraceProfileExecutionNode[] {
    return this.childrenByParent.get(node.nodeId) ?? [];
  }

  directEvents(node: TraceProfileExecutionNode): TraceEvent[] {
    if (node.kind === "event") {
      const event = node.eventSequence == null ? undefined : this.events[node.eventSequence];
      return event ? [event] : [];
    }

    return this.eventsBySpanId.get(node.spanId) ?? [];
  }

  eventOfType<K extends TraceEvent["type"]>(
    spanId: string,
    type: K,
  ): TraceEventByType<K> | undefined {
    return this.eventsBySpanId
      .get(spanId)
      ?.find((event): event is TraceEventByType<K> => isEvent(event, type));
  }
}
