/**
 * Maps @rejelly/core Message[] to DevTool ChatMessage[] for execution history.
 * Preserves tool role, tool results, and assistant tool_calls (AttemptStartEvent / AttemptEndEvent).
 * Lives under entities so TraceProcessor handlers can import without crossing into widgets.
 */
import type { ContentPart, Message, ToolCall } from "@rejelly/core";
import type { ChatMessage } from "src/entities/trace/types";

export type ToolCallPayload = NonNullable<ChatMessage["toolCalls"]>[number];

/**
 * Normalizes toolCalls from attempt:end payload into ChatMessage.toolCalls.
 */
export function mapToolCallsPayloadToChat(
  toolCalls?: ToolCall[],
): ChatMessage["toolCalls"] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }
  const out: ToolCallPayload[] = toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  }));
  return out.length > 0 ? out : undefined;
}

function contentPartToText(part: ContentPart): string {
  if (part.type === "text" && part.text) {
    return part.text;
  }
  if (part.type === "image" && part.image?.url) {
    return `[Image: ${part.image.url}]`;
  }
  if (part.type === "video" && part.video?.url) {
    return `[Video: ${part.video.url}]`;
  }
  return "";
}

function textFromContent(content: Message["content"]): string {
  const c = content;
  if (c === null || c === undefined) {
    return "";
  }
  if (typeof c === "string") {
    return c;
  }
  if (Array.isArray(c)) {
    return c.map(contentPartToText).filter(Boolean).join("\n");
  }
  return String(c);
}

const KNOWN_ROLES: ChatMessage["role"][] = ["system", "user", "assistant", "tool"];

/**
 * Core Message: tool results use role "tool" and tool_call_id; assistant may have tool_calls.
 */
function normalizeMessageRole(msg: Message): ChatMessage["role"] {
  const r = msg.role;
  if (typeof r === "string" && (KNOWN_ROLES as string[]).includes(r)) {
    return r as ChatMessage["role"];
  }
  if (msg.tool_call_id != null && String(msg.tool_call_id).length > 0) {
    return "tool";
  }
  if (typeof r === "string" && r.length > 0) {
    return r as ChatMessage["role"];
  }
  return "user";
}

/**
 * Converts core Message[] (attempt:start) to ChatMessage[], including tool / tool_calls.
 */
export function convertMessagesToChatMessages(messages: Message[]): ChatMessage[] {
  return messages.map((msg) => {
    const role = normalizeMessageRole(msg);
    const content = textFromContent(msg.content);

    const structuredToolCalls =
      role === "assistant" ? mapToolCallsPayloadToChat(msg.tool_calls) : undefined;

    return {
      role,
      content,
      reasoning_content:
        typeof msg.reasoning_content === "string" ? msg.reasoning_content : undefined,
      toolCalls: structuredToolCalls,
      toolCallId: msg.tool_call_id,
      name: msg.name,
    };
  });
}
