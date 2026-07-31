import { isKnownSessionEvent, type SessionEvent } from "./sessionEvents";

export const UNKNOWN_TOOL_OUTCOME_CONTENT =
  "[Tool execution outcome is unknown because the turn was interrupted]";

export interface IncompleteTurnRecovery {
  turnId: string;
  missingToolCalls: Array<{ id: string; name: string }>;
}

/**
 * Find durable turns that have messages but no later turn_completed boundary.
 *
 * The result is used only after a resumed run has acquired the writer lock. Missing tool results
 * are persisted as recovery messages before the old turn is closed as interrupted.
 */
export function findIncompleteTurnRecoveries(
  events: readonly SessionEvent[],
): IncompleteTurnRecovery[] {
  const turns = new Map<string, IncompleteTurnRecovery>();

  for (const event of events) {
    if (!isKnownSessionEvent(event)) {
      continue;
    }
    if (event.type === "turn_completed") {
      turns.delete(event.turnId);
      continue;
    }
    if (event.type !== "message_recorded") {
      continue;
    }

    const recovery = turns.get(event.turnId) ?? {
      turnId: event.turnId,
      missingToolCalls: [],
    };
    turns.set(event.turnId, recovery);

    if (event.message.role === "assistant") {
      for (const toolCall of event.message.tool_calls ?? []) {
        recovery.missingToolCalls.push({ id: toolCall.id, name: toolCall.name });
      }
      continue;
    }
    if (event.message.role === "tool" && event.message.tool_call_id) {
      const match = recovery.missingToolCalls.findIndex(
        (toolCall) => toolCall.id === event.message.tool_call_id,
      );
      if (match >= 0) {
        recovery.missingToolCalls.splice(match, 1);
      }
    }
  }

  return [...turns.values()];
}
