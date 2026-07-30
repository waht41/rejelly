import {
  type BudgetUpdatedEvent,
  type ContextCompactedEvent,
  isKnownSessionEvent,
  type LegacySnapshotImportedEvent,
  type MessageRecordedEvent,
  type RunSegmentEndedEvent,
  type RunSegmentStartedEvent,
  type SessionEvent,
  type SessionStateEvent,
  type TurnCompletedEvent,
} from "./sessionEvents";
import { parseStoredSessionMessage, type StoredSessionMessage } from "./storedSessionMessage";

declare const preparedSessionReplayBrand: unique symbol;

export type PreparedMessageRecordedEvent = MessageRecordedEvent & {
  message: StoredSessionMessage;
};

export type PreparedContextCompactedEvent = ContextCompactedEvent & {
  replacementHistory: StoredSessionMessage[];
};

export type PreparedLegacySnapshotImportedEvent = LegacySnapshotImportedEvent & {
  messages: StoredSessionMessage[];
};

export type PreparedSessionEvent =
  | RunSegmentStartedEvent
  | RunSegmentEndedEvent
  | PreparedMessageRecordedEvent
  | TurnCompletedEvent
  | PreparedContextCompactedEvent
  | SessionStateEvent
  | BudgetUpdatedEvent
  | PreparedLegacySnapshotImportedEvent;

/**
 * Validated, storage-shaped input shared by every session projection.
 *
 * It deliberately excludes forward-compatible unknown events while retaining their final
 * sequence/timestamp coordinates. Consumers cannot construct this opaque container directly.
 */
export interface PreparedSessionReplay {
  readonly events: readonly PreparedSessionEvent[];
  readonly lastSeq: number;
  readonly lastTimestamp?: number;
  readonly [preparedSessionReplayBrand]: true;
}

export function prepareSessionReplay(events: readonly SessionEvent[]): PreparedSessionReplay {
  const prepared: PreparedSessionEvent[] = [];
  let lastSeq = 0;
  let lastTimestamp: number | undefined;

  for (const event of events) {
    if (event.seq <= lastSeq) {
      throw new Error(
        `Session replay events must have strictly increasing seq values: ${event.seq} after ${lastSeq}`,
      );
    }
    lastSeq = event.seq;
    lastTimestamp = event.timestamp;

    if (!isKnownSessionEvent(event)) {
      continue;
    }
    switch (event.type) {
      case "message_recorded":
        prepared.push({
          ...event,
          message: parseStoredSessionMessage(event.message),
        });
        break;
      case "context_compacted":
        prepared.push({
          ...event,
          replacementHistory: event.replacementHistory.map(parseStoredSessionMessage),
        });
        break;
      case "legacy_snapshot":
        prepared.push({
          ...event,
          messages: event.messages.map(parseStoredSessionMessage),
        });
        break;
      default:
        prepared.push(event);
        break;
    }
  }

  return Object.freeze({
    events: Object.freeze(prepared),
    lastSeq,
    ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
  }) as PreparedSessionReplay;
}
