import {
  isKnownSessionEvent,
  type KnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import {
  dumpInitialContextInspection,
  type InitialContextInspection,
  projectInitialContextInspection,
} from "./checkpointInspection";
import { projectToolCallBySegment, type ToolCallInspection } from "./toolCallInspection";
import {
  resolveWaterfallSegment,
  type TurnWaterfallInspection,
  type TurnWaterfallSegment,
  type TurnWaterfallSegmentKind,
} from "./turnWaterfall";

export interface SegmentInspectionPayload {
  kind: "frozen_user_input" | "message" | "compaction";
  value: unknown;
}

export interface SegmentInspection {
  type: "segment_inspection_v1";
  sessionId: string;
  turnId: string;
  address: string;
  kind: TurnWaterfallSegmentKind;
  label: string;
  tokens: number;
  tokenSource: "provider" | "estimated";
  contextBefore: number;
  contextAfter: number;
  payload?: SegmentInspectionPayload;
  unavailableReason?: string;
}

export interface ParallelToolBatchCallInspection {
  address: string;
  requestAddress?: string;
  resultAddress?: string;
  toolCallId: string;
  toolName: string;
  status: ToolCallInspection["status"];
  requestTokens: number;
  resultTokens: number;
  totalTokens: number;
  durationMs?: number;
  requestPreview?: string;
  resultPreview?: string;
  resultLines?: number;
}

export interface ParallelToolBatchInspection {
  type: "parallel_tool_batch_inspection_v1";
  sessionId: string;
  turnId: string;
  selectedAddress: string;
  selectedSide: "requests" | "results";
  requestGroupAddress?: string;
  resultGroupAddress?: string;
  calls: ParallelToolBatchCallInspection[];
  totalTokens: number;
  estimatedWallDurationMs?: number;
  summedDurationMs?: number;
  contextBeforeRequests?: number;
  contextAfterRequests?: number;
  contextAfterResults?: number;
  contextGrowth?: number;
}

export type SegmentDrilldownInspection =
  | InitialContextInspection
  | SegmentInspection
  | ToolCallInspection
  | ParallelToolBatchInspection;

function knownTurnEvents(events: readonly SessionEvent[], turnId: string): KnownSessionEvent[] {
  return events.filter((event): event is KnownSessionEvent => {
    if (!isKnownSessionEvent(event)) return false;
    return (
      ("turnId" in event && event.turnId === turnId) ||
      (event.type === "context_compacted" && event.activeTurnId === turnId)
    );
  });
}

function compactPreview(value: string, maxLength = 120): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength - 1)}…`;
}

function groupToolCallIds(segment: TurnWaterfallSegment): string[] {
  return segment.children?.flatMap((child) => (child.toolCallId ? [child.toolCallId] : [])) ?? [];
}

function pairedParallelGroup(
  waterfall: TurnWaterfallInspection,
  selectedIndex: number,
): { requestIndex?: number; resultIndex?: number } {
  const selected = waterfall.segments[selectedIndex];
  const selectedIds = new Set(groupToolCallIds(selected));
  const selectedSide = selected.kind === "tool_result" ? "result" : "request";
  let bestIndex: number | undefined;
  let bestOverlap = 0;
  waterfall.segments.forEach((candidate, candidateIndex) => {
    if (
      candidateIndex === selectedIndex ||
      !candidate.children?.length ||
      (candidate.kind === "tool_result" ? "result" : "request") === selectedSide
    ) {
      return;
    }
    const overlap = groupToolCallIds(candidate).filter((id) => selectedIds.has(id)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = candidateIndex;
    }
  });
  return selectedSide === "request"
    ? {
        requestIndex: selectedIndex,
        ...(bestIndex !== undefined ? { resultIndex: bestIndex } : {}),
      }
    : {
        resultIndex: selectedIndex,
        ...(bestIndex !== undefined ? { requestIndex: bestIndex } : {}),
      };
}

function childAddressForCall(
  segment: TurnWaterfallSegment | undefined,
  segmentIndex: number | undefined,
  toolCallId: string,
): string | undefined {
  if (!segment || segmentIndex === undefined) return undefined;
  const childIndex = segment.children?.findIndex((child) => child.toolCallId === toolCallId) ?? -1;
  return childIndex >= 0 ? `${segmentIndex + 1}.${childIndex + 1}` : undefined;
}

function contextBoundary(
  segment: TurnWaterfallSegment | undefined,
  boundary: "before" | "after",
): number | undefined {
  const children = segment?.children;
  if (!children?.length) return undefined;
  return boundary === "before"
    ? children[0].contextTokens - children[0].tokens
    : children.at(-1)!.contextTokens;
}

function projectParallelToolBatch(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  waterfall: TurnWaterfallInspection,
  segmentIndex: number,
): ParallelToolBatchInspection {
  const selected = waterfall.segments[segmentIndex];
  const pair = pairedParallelGroup(waterfall, segmentIndex);
  const requestGroup =
    pair.requestIndex === undefined ? undefined : waterfall.segments[pair.requestIndex];
  const resultGroup =
    pair.resultIndex === undefined ? undefined : waterfall.segments[pair.resultIndex];
  const toolCallIds = [
    ...new Set([
      ...groupToolCallIds(requestGroup ?? selected),
      ...groupToolCallIds(resultGroup ?? selected),
    ]),
  ];
  const calls = toolCallIds.map((toolCallId) => {
    const inspection = projectToolCallBySegment(
      meta,
      events,
      waterfall,
      childAddressForCall(selected, segmentIndex, toolCallId) ??
        childAddressForCall(requestGroup, pair.requestIndex, toolCallId)!,
    );
    const requestAddress = childAddressForCall(requestGroup, pair.requestIndex, toolCallId);
    const resultAddress = childAddressForCall(resultGroup, pair.resultIndex, toolCallId);
    const address = selected.kind === "tool_result" ? resultAddress : requestAddress;
    return {
      address: address ?? requestAddress ?? resultAddress ?? toolCallId,
      ...(requestAddress ? { requestAddress } : {}),
      ...(resultAddress ? { resultAddress } : {}),
      toolCallId,
      toolName: inspection.toolName,
      status: inspection.status,
      requestTokens: inspection.request?.tokens ?? 0,
      resultTokens: inspection.result?.tokens ?? 0,
      totalTokens: inspection.totalTokens,
      ...(inspection.durationMs !== undefined ? { durationMs: inspection.durationMs } : {}),
      ...(inspection.request?.content
        ? { requestPreview: compactPreview(inspection.request.content) }
        : {}),
      ...(inspection.result?.content
        ? {
            resultPreview: compactPreview(inspection.result.content.split(/\r?\n/)[0] ?? ""),
            resultLines: inspection.result.lines,
          }
        : {}),
    };
  });
  const durations = calls.flatMap((call) =>
    call.durationMs === undefined ? [] : [call.durationMs],
  );
  const contextBeforeRequests = contextBoundary(requestGroup, "before");
  const contextAfterRequests = contextBoundary(requestGroup, "after");
  const contextAfterResults = contextBoundary(resultGroup, "after");
  return {
    type: "parallel_tool_batch_inspection_v1",
    sessionId: meta.sessionId,
    turnId: waterfall.turnId,
    selectedAddress: String(segmentIndex + 1),
    selectedSide: selected.kind === "tool_result" ? "results" : "requests",
    ...(pair.requestIndex !== undefined
      ? { requestGroupAddress: String(pair.requestIndex + 1) }
      : {}),
    ...(pair.resultIndex !== undefined ? { resultGroupAddress: String(pair.resultIndex + 1) } : {}),
    calls,
    totalTokens: calls.reduce((sum, call) => sum + call.totalTokens, 0),
    ...(durations.length > 0
      ? {
          estimatedWallDurationMs: Math.max(...durations),
          summedDurationMs: durations.reduce((sum, value) => sum + value, 0),
        }
      : {}),
    ...(contextBeforeRequests !== undefined ? { contextBeforeRequests } : {}),
    ...(contextAfterRequests !== undefined ? { contextAfterRequests } : {}),
    ...(contextAfterResults !== undefined ? { contextAfterResults } : {}),
    ...(contextBeforeRequests !== undefined && contextAfterResults !== undefined
      ? { contextGrowth: contextAfterResults - contextBeforeRequests }
      : {}),
  };
}

function payloadForSegment(
  events: readonly SessionEvent[],
  turnId: string,
  seq: number,
  kind: TurnWaterfallSegmentKind,
): { payload?: SegmentInspectionPayload; unavailableReason?: string } {
  const turnEvents = knownTurnEvents(events, turnId);
  if (kind === "user") {
    const event = turnEvents.find(
      (candidate) => candidate.seq === seq && candidate.type === "user_input_recorded",
    );
    return event?.type === "user_input_recorded"
      ? { payload: { kind: "frozen_user_input", value: event.input } }
      : { unavailableReason: "The persisted user input could not be resolved." };
  }
  if (kind === "assistant") {
    const modelCalls = turnEvents.filter((event) => event.type === "model_call_completed");
    const modelIndex = modelCalls.findIndex((event) => event.seq === seq);
    const modelMessages = turnEvents.filter(
      (event) => event.type === "message_recorded" && event.source.kind === "model",
    );
    const event = modelIndex >= 0 ? modelMessages[modelIndex] : undefined;
    return event?.type === "message_recorded"
      ? { payload: { kind: "message", value: event.message } }
      : { unavailableReason: "The persisted assistant message could not be resolved." };
  }
  if (kind === "runtime") {
    const event = turnEvents.find(
      (candidate) => candidate.seq === seq && candidate.type === "message_recorded",
    );
    return event?.type === "message_recorded"
      ? { payload: { kind: "message", value: event.message } }
      : { unavailableReason: "The persisted runtime message could not be resolved." };
  }
  if (kind === "compaction") {
    const event = turnEvents.find(
      (candidate) => candidate.seq === seq && candidate.type === "context_compacted",
    );
    return event?.type === "context_compacted"
      ? { payload: { kind: "compaction", value: event } }
      : { unavailableReason: "The persisted compaction event could not be resolved." };
  }
  if (kind === "reasoning") {
    return {
      unavailableReason:
        "Only the provider-reported reasoning token count is persisted; reasoning content is unavailable.",
    };
  }
  return { unavailableReason: "This segment has no separately persisted payload." };
}

export function projectSegmentDrilldown(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  waterfall: TurnWaterfallInspection,
  selector: string,
): SegmentDrilldownInspection {
  if (/^C[1-9]\d*$/i.test(selector)) {
    return projectInitialContextInspection(meta, events, waterfall, selector);
  }
  const resolved = resolveWaterfallSegment(waterfall, selector);
  if (resolved.childNumber === undefined && resolved.parent.children?.length) {
    return projectParallelToolBatch(meta, events, waterfall, resolved.segmentNumber - 1);
  }
  if (
    resolved.childNumber !== undefined ||
    resolved.parent.kind === "tool_request" ||
    resolved.parent.kind === "tool_result"
  ) {
    return projectToolCallBySegment(meta, events, waterfall, selector);
  }

  const details = payloadForSegment(
    events,
    waterfall.turnId,
    resolved.parent.seq,
    resolved.parent.kind,
  );
  return {
    type: "segment_inspection_v1",
    sessionId: meta.sessionId,
    turnId: waterfall.turnId,
    address: resolved.address,
    kind: resolved.parent.kind,
    label: resolved.parent.label,
    tokens: resolved.parent.tokens,
    tokenSource: resolved.parent.tokenSource,
    contextBefore: Math.max(0, resolved.parent.contextTokens - resolved.parent.tokens),
    contextAfter: resolved.parent.contextTokens,
    ...details,
  };
}

export function extractSegmentPayload(
  inspection: SegmentInspection | InitialContextInspection | ParallelToolBatchInspection,
): string {
  if (inspection.type === "initial_context_inspection_v1") {
    return dumpInitialContextInspection(inspection);
  }
  if (inspection.type === "parallel_tool_batch_inspection_v1") {
    const first = inspection.calls[0]?.address ?? `${inspection.selectedAddress}.1`;
    const last = inspection.calls.at(-1)?.address ?? first;
    throw new Error(
      `Segment ${inspection.selectedAddress} is a parallel group with ${inspection.calls.length} Tool calls. Select ${first}-${last} to extract one --payload.`,
    );
  }
  if (!inspection.payload) {
    throw new Error(
      `Segment ${inspection.address} has no durable payload: ${inspection.unavailableReason ?? "unavailable"}`,
    );
  }
  return JSON.stringify(inspection.payload.value, null, 2);
}
