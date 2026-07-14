import type { Message } from "@rejelly/core";
import { normalizeMessages } from "@rejelly/core/policy";

export function sanitizeInterruptedDelta(deltaMessages: Message[]): Message[] {
  const sanitized: Message[] = [];
  const pendingToolCallCounts = new Map<string, number>();

  for (const message of deltaMessages) {
    if (message.role !== "tool") {
      appendInterruptedToolOutputs(sanitized, pendingToolCallCounts);
    }

    sanitized.push(message);

    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        pendingToolCallCounts.set(toolCall.id, (pendingToolCallCounts.get(toolCall.id) ?? 0) + 1);
      }
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      const pendingCount = pendingToolCallCounts.get(message.tool_call_id) ?? 0;
      if (pendingCount === 1) {
        pendingToolCallCounts.delete(message.tool_call_id);
      } else if (pendingCount > 1) {
        pendingToolCallCounts.set(message.tool_call_id, pendingCount - 1);
      }
    }
  }

  appendInterruptedToolOutputs(sanitized, pendingToolCallCounts);
  return normalizeMessages(sanitized);
}

function appendInterruptedToolOutputs(
  messages: Message[],
  pendingToolCallCounts: Map<string, number>,
): void {
  for (const [toolCallId, count] of pendingToolCallCounts) {
    for (let index = 0; index < count; index++) {
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: "[Tool execution interrupted by user]",
      });
    }
  }
  pendingToolCallCounts.clear();
}
