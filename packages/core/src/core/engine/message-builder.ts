/**
 * Message Builder
 *
 * Normalization, validation, and wire-flattening helpers for LLM message arrays.
 */

import { InvalidMessageHistoryError } from "../domain/errors";
import type { ContentPart, Message, MessageContent } from "../domain/model";

/**
 * Normalize and validate a message history
 *
 * - Flattens message content into a normalized representation
 * - Validates tool-call pairing and rejects consecutive assistant messages
 *
 * Same-role adjacency is deliberately NOT collapsed here: whether consecutive same-role
 * messages are legal is a provider capability (OpenAI proper accepts them; strict-alternation
 * chat templates such as DeepSeek reasoner models reject them), so flattening belongs to each
 * adapter's wire conversion — see `mergeConsecutiveSameRoleMessages`. Collapsing earlier would
 * destroy message boundaries (separate historical turns) that adapters can represent natively.
 */
export function normalizeMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  const pendingToolCallCounts = new Map<string, number>();
  let previousRole: Message["role"] | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const normalized = pruneUndefinedFields({
      ...message,
      content: normalizeMessageContent(message.role, message.content),
      tool_calls: message.tool_calls ? [...message.tool_calls] : undefined,
      extra: message.extra ? { ...message.extra } : undefined,
    });
    validateMessageForHistory(normalized, index, previousRole, pendingToolCallCounts);
    result.push(normalized);
    previousRole = normalized.role;
  }

  if (pendingToolCallCounts.size > 0) {
    throw new InvalidMessageHistoryError(
      messages.length,
      `missing tool result for tool_call_id(s): ${formatPendingToolCallIds(pendingToolCallCounts)}`,
    );
  }

  return result;
}

/**
 * Collapse consecutive same-role messages into one (adapter-side wire-format helper)
 *
 * For providers whose chat templates require strict role alternation, adapters call this
 * immediately before wire conversion. Engine/policy code must not: message boundaries carry
 * information that only the final wire format may flatten.
 *
 * - Text content is joined across messages with a `\n\n` separator; non-text parts survive as-is
 * - Messages with differing `name`, differing `tool_call_id`, or any `extra` metadata never merge
 *
 * Does not mutate the input; unmerged messages are shallow-cloned into the result.
 */
export function mergeConsecutiveSameRoleMessages(messages: Message[]): Message[] {
  const merged: Message[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && canMergeMessages(previous, message)) {
      mergeIntoPrevious(previous, message);
      continue;
    }
    merged.push({ ...message });
  }

  return merged;
}

/**
 * Flatten multiple instructions into a single ContentPart[] without merging text.
 *
 * Each instruction stays as separate part(s), so per-block metadata (e.g. Anthropic
 * cache_control) is preserved. Strings are mapped to { type: "text", text }; existing
 * ContentPart[] are spread as-is.
 *
 * @param instructions - Array of MessageContent (string | ContentPart[])
 * @returns ContentPart[] (never merged; safe for adapter-specific metadata)
 */
export function flattenInstructions(instructions: MessageContent[]): ContentPart[] {
  const parts: ContentPart[] = [];

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (typeof inst === "string") {
      parts.push({ type: "text", text: inst });
    } else {
      parts.push(...inst);
    }
    if (i < instructions.length - 1) {
      parts.push({ type: "text", text: "\n\n" });
    }
  }

  return parts;
}

function validateMessageForHistory(
  message: Message,
  index: number,
  previousRole: Message["role"] | undefined,
  pendingToolCallCounts: Map<string, number>,
): void {
  if (previousRole === "assistant" && message.role === "assistant") {
    throw new InvalidMessageHistoryError(index, "consecutive assistant messages are not allowed");
  }

  if (message.role !== "tool" && pendingToolCallCounts.size > 0) {
    throw new InvalidMessageHistoryError(
      index,
      `missing tool result for tool_call_id(s): ${formatPendingToolCallIds(pendingToolCallCounts)}`,
    );
  }

  if (message.role === "tool") {
    consumePendingToolCall(message, index, pendingToolCallCounts);
    return;
  }

  const toolCalls = message.role === "assistant" ? (message.tool_calls ?? []) : [];
  for (const toolCall of toolCalls) {
    pendingToolCallCounts.set(toolCall.id, (pendingToolCallCounts.get(toolCall.id) ?? 0) + 1);
  }
}

function consumePendingToolCall(
  message: Message,
  index: number,
  pendingToolCallCounts: Map<string, number>,
): void {
  if (!message.tool_call_id) {
    throw new InvalidMessageHistoryError(index, "tool message is missing tool_call_id");
  }

  const pendingCount = pendingToolCallCounts.get(message.tool_call_id) ?? 0;
  if (pendingCount === 0) {
    throw new InvalidMessageHistoryError(
      index,
      `tool message references unknown tool_call_id: ${message.tool_call_id}`,
    );
  }

  if (pendingCount === 1) {
    pendingToolCallCounts.delete(message.tool_call_id);
    return;
  }
  pendingToolCallCounts.set(message.tool_call_id, pendingCount - 1);
}

function formatPendingToolCallIds(pendingToolCallCounts: Map<string, number>): string {
  return [...pendingToolCallCounts.entries()]
    .flatMap(([id, count]) => Array.from({ length: count }, () => id))
    .join(", ");
}

function normalizeMessageContent(
  role: Message["role"],
  content: MessageContent | null,
): MessageContent | null {
  if (content === null) {
    return null;
  }
  return fromContentParts(toContentParts(content), role);
}

function canMergeMessages(previous: Message, current: Message): boolean {
  if (previous.role !== current.role) {
    return false;
  }
  if (previous.name !== current.name) {
    return false;
  }
  if (previous.extra !== undefined || current.extra !== undefined) {
    return false;
  }
  if (previous.role === "tool") {
    return previous.tool_call_id === current.tool_call_id;
  }
  return previous.tool_call_id === current.tool_call_id;
}

function mergeIntoPrevious(previous: Message, current: Message): void {
  previous.content = mergeMessageContent(previous.role, previous.content, current.content);
  if (previous.role === "assistant" || current.role === "assistant") {
    previous.reasoning_content = mergeStrings(
      previous.reasoning_content,
      current.reasoning_content,
    );
    if (current.tool_calls && current.tool_calls.length > 0) {
      previous.tool_calls = [...(previous.tool_calls ?? []), ...current.tool_calls];
    }
  }
}

function mergeMessageContent(
  role: Message["role"],
  previous: MessageContent | null,
  current: MessageContent | null,
): MessageContent | null {
  const previousParts = toContentParts(previous);
  const currentParts = toContentParts(current);

  if (previousParts.length === 0) {
    return fromContentParts(currentParts, role);
  }
  if (currentParts.length === 0) {
    return fromContentParts(previousParts, role);
  }

  const separator: ContentPart = { type: "text", text: "\n\n" };
  const mergedParts =
    role === "tool"
      ? [...previousParts, ...currentParts]
      : [...previousParts, separator, ...currentParts];
  // Text-only merges collapse to a plain string even for user role: downstream wire conversion
  // joins text parts with its own separator, which would double up with the one inserted here.
  if (mergedParts.every((part) => part.type === "text")) {
    return mergedParts.map((part) => part.text).join("");
  }
  return fromContentParts(mergedParts, role);
}

function toContentParts(content: MessageContent | null): ContentPart[] {
  if (content === null) {
    return [];
  }
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [...content];
}

function fromContentParts(
  parts: ContentPart[],
  role: Message["role"] = "user",
): MessageContent | null {
  if (parts.length === 0) {
    return null;
  }
  if (role !== "user" && parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

function mergeStrings(previous?: string, current?: string): string | undefined {
  if (!previous) {
    return current;
  }
  if (!current) {
    return previous;
  }
  return `${previous}\n\n${current}`;
}

function pruneUndefinedFields(message: Message): Message {
  return Object.fromEntries(
    Object.entries(message).filter(([, value]) => value !== undefined),
  ) as Message;
}
