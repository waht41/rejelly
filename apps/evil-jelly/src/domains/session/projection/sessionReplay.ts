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
} from "../model/sessionEvents";
import {
  parseStoredSessionMessage,
  type StoredSessionMessage,
} from "../model/storedSessionMessage";

declare const preparedSessionReplayBrand: unique symbol;

// StoredSessionMessage is stricter than Core Message at the persistence boundary: image data URLs
// have already become durable blob references and carry the metadata needed to materialize them.
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
    // Strict ordering is checked before filtering unknown events. A future event type still occupies
    // a real sequence coordinate and must participate in corruption/gap diagnostics.
    if (event.seq <= lastSeq) {
      throw new Error(
        `Session replay events must have strictly increasing seq values: ${event.seq} after ${lastSeq}`,
      );
    }
    lastSeq = event.seq;
    lastTimestamp = event.timestamp;

    if (!isKnownSessionEvent(event)) {
      // Forward-compatible unknown events are invisible to current projections, but lastSeq and
      // lastTimestamp above retain their envelope coordinates for status and later suffix replay.
      continue;
    }
    switch (event.type) {
      case "message_recorded":
        // Parse nested messages once here so every downstream projection receives the same
        // storage-safe representation instead of independently trusting raw JSON payloads.
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
    // The opaque brand plus freezing makes this the only construction boundary accepted by
    // projections; callers cannot accidentally pass unvalidated SessionEvent arrays.
  }) as PreparedSessionReplay;
}
