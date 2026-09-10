import {
  isKnownSessionEvent,
  type KnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { projectToolCallBySegment, type ToolCallInspection } from "./toolCallInspection";
import {
  resolveWaterfallSegment,
  type TurnWaterfallInspection,
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

export type SegmentDrilldownInspection = SegmentInspection | ToolCallInspection;

function knownTurnEvents(events: readonly SessionEvent[], turnId: string): KnownSessionEvent[] {
  return events.filter((event): event is KnownSessionEvent => {
    if (!isKnownSessionEvent(event)) return false;
    return (
      ("turnId" in event && event.turnId === turnId) ||
      (event.type === "context_compacted" && event.activeTurnId === turnId)
    );
  });
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
  const resolved = resolveWaterfallSegment(waterfall, selector);
  if (resolved.childNumber === undefined && resolved.parent.children?.length) {
    throw new Error(
      `Segment ${resolved.segmentNumber} contains ${resolved.parent.children.length} Tool calls; select ${resolved.segmentNumber}.1-${resolved.segmentNumber}.${resolved.parent.children.length}.`,
    );
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

export function dumpSegmentPayload(inspection: SegmentInspection): string {
  if (!inspection.payload) {
    throw new Error(
      `Segment ${inspection.address} has no durable payload: ${inspection.unavailableReason ?? "unavailable"}`,
    );
  }
  return JSON.stringify(inspection.payload.value, null, 2);
}
