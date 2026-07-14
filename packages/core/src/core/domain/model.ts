/**
 * LLM Interaction Layer Types
 *
 * Types related to direct interaction with LLM models,
 * including messages, tokens, streaming, and adapters.
 */

import type { ToolChoice, ToolDefinition } from "./tool";

/**
 * Finish reason (standardized).
 * - stop: Natural end of generation
 * - length: Hit max_tokens limit (truncated)
 * - tool_calls: Model requested tool invocation
 * - content_filter: Triggered safety filter
 * - error: Error occurred
 */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "unknown";

/**
 * Token usage statistics returned by LLM
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Extension field for adapter-specific details (e.g., reasoningTokens, cacheReadTokens) */
  details?: {
    /** Reasoning tokens (e.g. <think>...</think>); important for pricing on reasoning models */
    reasoningTokens?: number;

    /** Tokens saved/read from prompt cache (e.g. Anthropic/OpenAI prompt caching) */
    cacheReadTokens?: number;

    /** Tokens newly written to prompt cache */
    cacheWriteTokens?: number;
    [key: string]: number | undefined;
  };
}

/**
 * Message role in conversation
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Tool call result from LLM
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  /** Provider-specific extra metadata, transparently carried by core. */
  extra?: Record<string, unknown>;
}

/**
 * Image content definition
 * Supports URL (public images) or Base64 (local/uploaded images)
 */
export interface ImageContent {
  url: string; // http://... or data:image/png;base64,...
  detail?: "auto" | "low" | "high"; // Detail control for vision models (OpenAI style)
}

/**
 * Video content definition
 * Videos are usually URL references, some models support Base64
 */
export interface VideoContent {
  url: string;
}

/**
 * Atomic parts of multimodal content
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageContent }
  | { type: "video"; video: VideoContent }; // Reserved for future, e.g., Gemini native video support

/**
 * Message content type
 * - string: Shorthand mode, plain text (for developer experience, keep string direct assignment)
 * - ContentPart[]: Complex mode, mixed text and images
 */
export type MessageContent = string | ContentPart[];

/**
 * LLM message structure
 */
export interface Message {
  role: MessageRole;
  content: MessageContent | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string; // Optional: OpenAI supports specifying name for user/function
  /** Message-level provider-specific metadata. */
  extra?: Record<string, unknown>;
}

export const REJELLY_INSTRUCTION_MESSAGE_KIND = "instruction";

export function isInstructionMessage(message: Message): boolean {
  const rejelly = message.extra?.rejelly;
  return (
    typeof rejelly === "object" &&
    rejelly !== null &&
    "kind" in rejelly &&
    rejelly.kind === REJELLY_INSTRUCTION_MESSAGE_KIND
  );
}

/**
 * JSON Schema type (simplified)
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  $schema?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
}

/**
 * Tool call chunk for streaming
 */
export interface ToolCallChunk {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
  /** Provider-specific chunk metadata (e.g. Gemini thoughtSignature). */
  extra?: Record<string, unknown>;
}

/**
 * Stream event types (tagged union)
 */
export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; toolCall: ToolCallChunk }
  | { type: "extra"; extra: Record<string, unknown> }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; error: unknown }
  | { type: "finish"; finishReason: FinishReason; usage?: TokenUsage };

/**
 * Model stream options
 */
export interface ModelStreamOptions {
  schema?: JsonSchema;
  /** Tools available to the model */
  tools?: ToolDefinition[];
  /** Tool choice strategy */
  toolChoice?: ToolChoice;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Escape hatch for provider-specific options */
  additionalOptions?: Record<string, unknown>;
}

/**
 * Model adapter interface
 */
export interface ModelAdapter {
  id: string;
  provider?: string;
  stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent>;
  /**
   * Cost calculator. Return values must be plain objects with integer values per billing unit
   * (e.g. { micro_usd: 1500 }); use micro_* units to avoid floating-point currency.
   */
  calculateCost?(usage: TokenUsage): Record<string, number>;
}

/**
 * Model middleware interface
 *
 * A middleware describes how to wrap a ModelAdapter with additional capabilities.
 */
export interface ModelMiddleware {
  /** Middleware name (for debugging and logging) */
  name: string;

  /** The wrapping logic */
  wrap: (inner: ModelAdapter) => ModelAdapter;

  /** Optional: config snapshot for debugging/dashboard display */
  config?: Record<string, unknown>;
}
