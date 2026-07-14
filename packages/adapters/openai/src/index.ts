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
