import type { Message } from "@rejelly/core";
import type { ToolExecutionOutcomeRecord } from "./model";

// Host-only facts: never add execution metadata to the provider-facing Message shape.
const messageOutcomes = new WeakMap<Message, ToolExecutionOutcomeRecord>();

export function getMessageToolOutcome(message: Message): ToolExecutionOutcomeRecord | undefined {
  return messageOutcomes.get(message);
}

export function registerMessageToolOutcome<T extends Message>(
  message: T,
  outcome: ToolExecutionOutcomeRecord,
): T {
  messageOutcomes.set(message, { ...outcome });
  return message;
}

export function copyMessageToolOutcome<T extends Message>(source: Message, target: T): T {
  const outcome = getMessageToolOutcome(source);
  return outcome ? registerMessageToolOutcome(target, outcome) : target;
}

/** One dispatch batch, not a session-global lookup by reusable provider call IDs. */
export class ToolOutcomeCollector {
  #pending = new Map<string, ToolExecutionOutcomeRecord | undefined>();

  beginBatch(calls: readonly { id: string }[]): void {
    this.#pending.clear();
    const duplicates = new Set<string>();
    for (const call of calls) {
      if (this.#pending.has(call.id)) duplicates.add(call.id);
      this.#pending.set(call.id, undefined);
    }
    // An ID alone cannot attribute concurrent calls with duplicate IDs safely.
    for (const id of duplicates) this.#pending.delete(id);
  }

  record(toolCallId: string, outcome: ToolExecutionOutcomeRecord): void {
    if (this.#pending.has(toolCallId)) this.#pending.set(toolCallId, outcome);
  }

  attach(messages: readonly Message[]): void {
    for (const message of messages) {
      if (message.role !== "tool" || !message.tool_call_id) continue;
      const outcome = this.#pending.get(message.tool_call_id);
      if (outcome) registerMessageToolOutcome(message, outcome);
      this.#pending.delete(message.tool_call_id);
    }
    this.#pending.clear();
  }
}
