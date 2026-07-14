/**
 * Pure data transformation and error classification for the OpenAI adapter.
 * All functions are side-effect free (except wrapAsModelCallError which throws).
 */

import type {
  ContentPart,
  Message,
  ModelErrorCode,
  ToolChoice,
  ToolDefinition,
} from "@rejelly/core";
import { AbortError, isAbortError, isNotSupportedError, ModelCallError } from "@rejelly/core";
import { mergeConsecutiveSameRoleMessages } from "@rejelly/core/policy";
import { APIError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions/completions";
import { zodToJsonSchema } from "zod-to-json-schema";

type OpenAIReasoningAssistantMessageParam = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

// ── Schema injection (for models without native JSON Schema support) ───

export function generateSchemaInstruction(schema: Record<string, unknown>): string {
  const schemaStr = JSON.stringify(schema, null, 2);
  return `\n\n## Response Format

You MUST respond with a valid JSON object that strictly conforms to the following JSON Schema:

\`\`\`json
${schemaStr}
\`\`\`

Important Rules:
- The core of your response MUST be the JSON object.
- Do NOT output any conversational text, pleasantries, or explanations.
- Ensure all required fields are present and follow the exact types specified.
- If additional formatting protocols are provided by model middleware, follow them exactly.`;
}

export function injectSchemaToMessages(
  messages: Message[],
  schema: Record<string, unknown>,
): Message[] {
  const instruction = generateSchemaInstruction(schema);
  const result = [...messages];
  const systemIndex = result.findIndex((m) => m.role === "system");

  if (systemIndex >= 0) {
    const existing = result[systemIndex].content;
    if (typeof existing === "string") {
      result[systemIndex] = { ...result[systemIndex], content: existing + instruction };
    } else if (Array.isArray(existing)) {
      const preserved = existing.map((p) =>
        p?.type === "text"
          ? { type: "text" as const, text: (p as { type: "text"; text: string }).text }
          : p,
      );
      result[systemIndex] = {
        ...result[systemIndex],
        content: [...preserved, { type: "text" as const, text: instruction }],
      };
    } else {
      result[systemIndex] = { ...result[systemIndex], content: instruction.trim() };
    }
  } else {
    result.unshift({ role: "system", content: instruction.trim() });
  }

  return result;
}

// ── Message conversion ─────────────────────────────────────

export function convertContentToString(content: Message["content"]): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Tool result text when a tool returns media only — points the model at the follow-up user message. */
const TOOL_MEDIA_FALLBACK_TEXT =
  "[Tool returned non-text content; see the following user message.]";

/**
 * Chat Completions tool result messages are text-only. When a tool returns media
 * (e.g. an image via `toolContent`), keep the text in the tool result and forward the
 * media as a follow-up user message so the model can actually see it.
 */
function buildToolMessages(msg: Message): ChatCompletionMessageParam[] {
  const toolCallId = msg.tool_call_id ?? "";
  if (!Array.isArray(msg.content)) {
    return [
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: convertContentToString(msg.content) ?? "",
      },
    ];
  }

  const mediaParts: ContentPart[] = msg.content.filter((part) => part.type !== "text");
  if (mediaParts.length === 0) {
    return [
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: convertContentToString(msg.content) ?? "",
      },
    ];
  }

  const toolText = convertContentToString(msg.content) ?? "";
  const userContent = convertContentMultimodal([
    { type: "text", text: `Tool result content for call ${toolCallId || "(unknown)"}:` },
    ...mediaParts,
  ]);
  return [
    {
      role: "tool",
      tool_call_id: toolCallId,
      content: toolText.length > 0 ? toolText : TOOL_MEDIA_FALLBACK_TEXT,
    },
    { role: "user", content: userContent ?? "" },
  ];
}

export function convertContentMultimodal(
  content: Message["content"],
): string | ChatCompletionContentPart[] | null {
  if (!content) return null;
  if (typeof content === "string") return content;

  const hasNonText = content.some((part) => part.type !== "text");
  if (!hasNonText) {
    return content.map((part) => (part as { type: "text"; text: string }).text).join("\n");
  }

  return content.map((part): ChatCompletionContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: { url: part.image.url, detail: part.image.detail },
      };
    }
    throw new Error(`Unsupported content part type: ${(part as { type: string }).type}`);
  });
}

/**
 * Convert Rejelly messages to Chat Completions messages.
 *
 * Consecutive same-role messages are collapsed first: the endpoint is a user-configured
 * OpenAI-compatible URL whose chat template's strictness is unknowable, and strict-alternation
 * backends (e.g. DeepSeek reasoner models) reject consecutive same-role messages outright, so
 * merging by default is the only choice that cannot break a provider. OpenAI proper tolerates
 * the merged form equally well.
 *
 * Chat Completions tool result messages are text-only, so a tool message carrying media
 * (e.g. an image returned via `toolContent`) is automatically split into two messages: a text
 * tool result plus a follow-up `user` message holding the media, so the model can actually see it.
 */
export function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  for (const msg of mergeConsecutiveSameRoleMessages(messages)) {
    switch (msg.role) {
      case "system":
        result.push({ role: "system", content: convertContentToString(msg.content) ?? "" });
        break;
      case "user":
        result.push({ role: "user", content: convertContentMultimodal(msg.content) ?? "" });
        break;
      case "assistant": {
        const content = convertContentToString(msg.content);
        const reasoningContent = msg.reasoning_content;
        if (msg.tool_calls?.length) {
          const assistantMessage: OpenAIReasoningAssistantMessageParam = {
            role: "assistant",
            content: content || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
          if (reasoningContent) {
            assistantMessage.reasoning_content = reasoningContent;
          }
          result.push(assistantMessage);
          break;
        }
        const assistantMessage: OpenAIReasoningAssistantMessageParam = {
          role: "assistant",
          content: content ?? "",
        };
        if (reasoningContent) {
          assistantMessage.reasoning_content = reasoningContent;
        }
        result.push(assistantMessage);
        break;
      }
      case "tool":
        result.push(...buildToolMessages(msg));
        break;
      default:
        throw new Error(`Unknown message role: ${msg.role}`);
    }
  }
  return result;
}

export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters, {
        $refStrategy: "none",
      }) as Record<string, unknown>,
    },
  }));
}

export function toOpenAIToolChoice(
  toolChoice: ToolChoice,
): ChatCompletionToolChoiceOption | undefined {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required")
    return toolChoice;
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "function", function: { name: toolChoice.function.name } };
  }
  return undefined;
}

// ── Error handling ─────────────────────────────────────────

export function classifyOpenAIError(error: unknown): ModelErrorCode {
  if (error instanceof APIError) {
    const status = error.status;
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth_error";
    if (status === 500 || status === 502 || status === 503) return "server_error";
    if (
      status === 400 &&
      typeof error.message === "string" &&
      /context.length|max.*tokens|too.long/i.test(error.message)
    ) {
      return "context_length";
    }
  }
  return "unknown";
}

function isOpenAIAbortLikeError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (error === null || typeof error !== "object") {
    return false;
  }
  const rec = error as Record<string, unknown>;
  return rec.message === "Request was aborted." || rec.name === "APIUserAbortError";
}

export function wrapAsModelCallError(
  error: unknown,
  modelId: string,
  provider?: string,
  endpoint?: string,
): never {
  if (isOpenAIAbortLikeError(error)) {
    throw new AbortError(error instanceof Error ? error.message : undefined);
  }
  if (isNotSupportedError(error)) {
    throw error;
  }
  throw new ModelCallError(error instanceof Error ? error.message : String(error), {
    modelId,
    provider,
    endpoint,
    code: classifyOpenAIError(error),
    originalError: error,
  });
}
