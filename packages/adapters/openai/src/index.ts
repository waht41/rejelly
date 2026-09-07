/**
 * OpenAI-Compatible Model Adapter
 *
 * A self-contained ModelAdapter implementation using the OpenAI SDK.
 * Supports streaming, tool calling, structured outputs, and multimodal content.
 *
 * @packageDocumentation
 */

export type {
  ChatCompletionParams,
  OpenAIAdapterConfig,
  RequestOption,
  SchemaMode,
} from "./adapter";
export { createOpenAIAdapter } from "./adapter";
export { OPENAI_CHAT_STATE_KIND, OPENAI_RESPONSES_STATE_KIND } from "./identity";
export type { ResponseParams } from "./responses";
export { toOpenAIResponseInput } from "./responses";
export type { OpenAIUsageProtocol } from "./usage";
export { normalizeOpenAIUsage } from "./usage";
