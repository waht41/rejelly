import {
  isKnownSessionEvent,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";
import { messageContentToText } from "../../shared/model/message/content";
import {
  resolveWaterfallSegment,
  type TurnWaterfallChild,
  type TurnWaterfallInspection,
  type TurnWaterfallSegment,
} from "./turnWaterfall";

export type ToolCallSelectionSide = "request" | "result";

export interface ToolCallPayloadInspection {
  address?: string;
  tokens?: number;
  tokenSource?: "provider" | "estimated";
  contextBefore?: number;
  contextAfter?: number;
  content: string;
  chars: number;
  bytes: number;
  lines: number;
}

export interface ToolCallInspection {
  type: "tool_call_inspection_v1";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  selectedSide: ToolCallSelectionSide;
  status: "pending" | "succeeded" | "failed" | "denied" | "aborted" | "timed_out";
  durationMs?: number;
  transportOk?: boolean;
  exitCode?: number | null;
  failureKind?: string;
  fromCache?: boolean;
  outputBytes?: number;
  outputChars?: number;
  admittedResultBytes?: number;
  admittedResultChars?: number;
  truncated?: boolean;
  truncationReason?: "size_limit" | "line_limit" | "host_summary";
  request?: ToolCallPayloadInspection;
  result?: ToolCallPayloadInspection;
  totalTokens: number;
}

interface AddressedCall {
  toolCallId: string;
  side: ToolCallSelectionSide;
}

interface ToolCallAddress {
  address: string;
  side: ToolCallSelectionSide;
  tokens: number;
  tokenSource: "provider" | "estimated";
  contextBefore: number;
  contextAfter: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function payload(content: string, address?: ToolCallAddress): ToolCallPayloadInspection {
  return {
    ...(address
      ? {
          address: address.address,
          tokens: address.tokens,
          tokenSource: address.tokenSource,
          contextBefore: address.contextBefore,
          contextAfter: address.contextAfter,
        }
      : {}),
    content,
    chars: content.length,
    bytes: utf8Bytes(content),
    lines: lineCount(content),
  };
}

function segmentCall(
  segment: TurnWaterfallSegment | TurnWaterfallChild,
  side: ToolCallSelectionSide,
): AddressedCall {
  if (!segment.toolCallId) throw new Error("Selected segment is not a Tool call.");
  return { toolCallId: segment.toolCallId, side };
}

export function resolveSegmentToolCall(
  waterfall: TurnWaterfallInspection,
  selector: string,
): AddressedCall {
  const resolved = resolveWaterfallSegment(waterfall, selector);
  if (resolved.childNumber !== undefined) {
    const side = resolved.parent.kind === "tool_result" ? "result" : "request";
    return segmentCall(resolved.segment, side);
  }
  if (resolved.parent.children?.length) {
    throw new Error(
      `Segment ${resolved.segmentNumber} contains ${resolved.parent.children.length} Tool calls; select ${resolved.segmentNumber}.1-${resolved.segmentNumber}.${resolved.parent.children.length}.`,
    );
  }
  if (resolved.parent.kind !== "tool_request" && resolved.parent.kind !== "tool_result") {
    throw new Error(`Segment ${resolved.segmentNumber} is not a Tool request or result.`);
  }
  return segmentCall(
    resolved.segment,
    resolved.parent.kind === "tool_request" ? "request" : "result",
  );
}

function addressesForCall(
  waterfall: TurnWaterfallInspection,
  toolCallId: string,
): { request?: ToolCallAddress; result?: ToolCallAddress } {
  const addresses: { request?: ToolCallAddress; result?: ToolCallAddress } = {};
  waterfall.segments.forEach((segment, segmentIndex) => {
    if (segment.children?.length) {
      segment.children.forEach((child, childIndex) => {
        if (child.toolCallId !== toolCallId) return;
        const side = segment.kind === "tool_result" ? "result" : "request";
        addresses[side] = {
          address: `${segmentIndex + 1}.${childIndex + 1}`,
          side,
          tokens: child.tokens,
          tokenSource: child.tokenSource,
          contextBefore: child.contextTokens - child.tokens,
          contextAfter: child.contextTokens,
        };
      });
      return;
    }
    if (segment.toolCallId !== toolCallId) return;
    const side = segment.kind === "tool_request" ? "request" : "result";
    addresses[side] = {
      address: String(segmentIndex + 1),
      side,
      tokens: segment.tokens,
      tokenSource: segment.tokenSource,
      contextBefore: segment.contextTokens - segment.tokens,
      contextAfter: segment.contextTokens,
    };
  });
  return addresses;
}

export function findToolCallTurnId(events: readonly SessionEvent[], toolCallId: string): string {
  const turnIds = new Set<string>();
  for (const event of events) {
    if (!isKnownSessionEvent(event)) continue;
    if (
      (event.type === "tool_call_completed" || event.type === "tool_observation_recorded") &&
      event.toolCallId === toolCallId &&
      event.turnId
    ) {
      turnIds.add(event.turnId);
    }
    if (event.type === "message_recorded") {
      if (event.message.tool_call_id === toolCallId) turnIds.add(event.turnId);
      if (event.message.tool_calls?.some((call) => call.id === toolCallId))
        turnIds.add(event.turnId);
    }
  }
  if (turnIds.size === 0) throw new Error(`Tool call not found in Session: ${toolCallId}`);
  if (turnIds.size > 1) throw new Error(`Tool call id is not unique in Session: ${toolCallId}`);
  return [...turnIds][0];
}

export function projectToolCallInspection(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  waterfall: TurnWaterfallInspection,
  toolCallId: string,
  selectedSide?: ToolCallSelectionSide,
): ToolCallInspection {
  let toolName: string | undefined;
  let argumentsText: string | undefined;
  let resultText: string | undefined;
  let completion:
    | {
        durationMs: number;
        transportOk: boolean;
        outcome?: "succeeded" | "failed" | "denied" | "aborted" | "timed_out";
        exitCode?: number | null;
        failureKind?: string;
        fromCache: boolean;
        outputBytes: number;
        outputChars: number;
        admittedResultBytes?: number;
        admittedResultChars?: number;
        truncated?: boolean;
        truncationReason?: "size_limit" | "line_limit" | "host_summary";
      }
    | undefined;

  for (const event of events) {
    if (!isKnownSessionEvent(event)) continue;
    if (event.type === "message_recorded") {
      const call = event.message.tool_calls?.find((candidate) => candidate.id === toolCallId);
      if (call) {
        toolName = call.name;
        argumentsText = call.arguments;
      }
      if (event.message.tool_call_id === toolCallId) {
        toolName ??= event.message.name;
        resultText = messageContentToText(event.message.content);
      }
    }
    if (event.type === "tool_observation_recorded" && event.toolCallId === toolCallId) {
      toolName = event.toolName;
      argumentsText ??= event.args;
    }
    if (event.type === "tool_call_completed" && event.toolCallId === toolCallId) {
      toolName = event.toolName;
      completion = event;
    }
  }
  if (!toolName) throw new Error(`Tool call not found in Session ${meta.sessionId}: ${toolCallId}`);

  const addresses = addressesForCall(waterfall, toolCallId);
  const request =
    argumentsText !== undefined ? payload(argumentsText, addresses.request) : undefined;
  const result = resultText !== undefined ? payload(resultText, addresses.result) : undefined;
  const side = selectedSide ?? (result ? "result" : "request");
  return {
    type: "tool_call_inspection_v1",
    sessionId: meta.sessionId,
    turnId: waterfall.turnId,
    toolCallId,
    toolName,
    selectedSide: side,
    status:
      completion?.outcome ??
      (completion?.transportOk === false ? "failed" : completion ? "succeeded" : "pending"),
    ...(completion
      ? {
          durationMs: completion.durationMs,
          transportOk: completion.transportOk,
          ...(completion.exitCode !== undefined ? { exitCode: completion.exitCode } : {}),
          ...(completion.failureKind ? { failureKind: completion.failureKind } : {}),
          fromCache: completion.fromCache,
          outputBytes: completion.outputBytes,
          outputChars: completion.outputChars,
          ...(completion.admittedResultBytes !== undefined
            ? { admittedResultBytes: completion.admittedResultBytes }
            : {}),
          ...(completion.admittedResultChars !== undefined
            ? { admittedResultChars: completion.admittedResultChars }
            : {}),
          ...(completion.truncated !== undefined ? { truncated: completion.truncated } : {}),
          ...(completion.truncationReason ? { truncationReason: completion.truncationReason } : {}),
        }
      : {}),
    ...(request ? { request } : {}),
    ...(result ? { result } : {}),
    totalTokens: (request?.tokens ?? 0) + (result?.tokens ?? 0),
  };
}

export function projectToolCallBySegment(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  waterfall: TurnWaterfallInspection,
  selector: string,
): ToolCallInspection {
  const selected = resolveSegmentToolCall(waterfall, selector);
  return projectToolCallInspection(meta, events, waterfall, selected.toolCallId, selected.side);
}

export function extractToolCallPayload(inspection: ToolCallInspection): string {
  const selected = inspection.selectedSide === "request" ? inspection.request : inspection.result;
  const fallback = inspection.result ?? inspection.request;
  if (!selected && !fallback)
    throw new Error(`Tool call ${inspection.toolCallId} has no durable payload.`);
  return (selected ?? fallback)!.content;
}
