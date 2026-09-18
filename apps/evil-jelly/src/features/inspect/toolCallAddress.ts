import { isKnownSessionEvent, type SessionEvent } from "../../domains/session/model/sessionEvents";

export interface ToolCallIdentity {
  ordinal: number;
  address: string;
  toolCallId: string;
  toolName?: string;
  turnId?: string;
  firstSeq: number;
  firstTimestamp: number;
}

interface CollectedToolCallIdentity extends Omit<ToolCallIdentity, "ordinal" | "address"> {}

export function projectToolCallIdentities(events: readonly SessionEvent[]): ToolCallIdentity[] {
  const calls = new Map<string, CollectedToolCallIdentity>();
  const record = (
    toolCallId: string,
    seq: number,
    timestamp: number,
    toolName?: string,
    turnId?: string,
  ): void => {
    const existing = calls.get(toolCallId);
    if (!existing) {
      calls.set(toolCallId, {
        toolCallId,
        toolName,
        turnId,
        firstSeq: seq,
        firstTimestamp: timestamp,
      });
      return;
    }
    if (existing.turnId && turnId && existing.turnId !== turnId) {
      throw new Error(`Tool call id is not unique in Session: ${toolCallId}`);
    }
    existing.toolName ??= toolName;
    existing.turnId ??= turnId;
    if (seq < existing.firstSeq) {
      existing.firstSeq = seq;
      existing.firstTimestamp = timestamp;
    }
  };

  for (const event of events) {
    if (!isKnownSessionEvent(event)) continue;
    if (event.type === "tool_call_completed" || event.type === "tool_observation_recorded") {
      record(event.toolCallId, event.seq, event.timestamp, event.toolName, event.turnId);
    }
    if (event.type === "message_recorded") {
      for (const call of event.message.tool_calls ?? []) {
        record(call.id, event.seq, event.timestamp, call.name, event.turnId);
      }
      if (event.message.tool_call_id) {
        record(
          event.message.tool_call_id,
          event.seq,
          event.timestamp,
          event.message.name,
          event.turnId,
        );
      }
    }
  }

  return [...calls.values()]
    .sort(
      (left, right) => left.firstSeq - right.firstSeq || left.firstTimestamp - right.firstTimestamp,
    )
    .map((identity, index) => ({
      ...identity,
      ordinal: index + 1,
      address: `TC${index + 1}`,
    }));
}

export function resolveToolCallIdentity(
  events: readonly SessionEvent[],
  selector: string,
): ToolCallIdentity | undefined {
  const identities = projectToolCallIdentities(events);
  const address = /^TC([1-9]\d*)$/i.exec(selector.trim());
  if (address) {
    const identity = identities[Number(address[1]) - 1];
    if (!identity) {
      throw new Error(`Tool Call address ${selector} is outside this Session.`);
    }
    return identity;
  }
  return identities.find((identity) => identity.toolCallId === selector);
}
