/**
 * Gemini Model Adapter
 *
 * A self-contained ModelAdapter implementation using the Google Generative AI SDK.
 * Supports streaming, tools, multimodal content (images/videos), and abort signals.
 *
 * @packageDocumentation
 */

export type { GeminiAdapterConfig, GenerateContentParams, SchemaMode } from "./adapter";
export { createGeminiAdapter, createGeminiAdapter as default } from "./adapter";
