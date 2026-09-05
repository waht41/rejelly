/**
 * OpenAI adapter: stream handler and adapter factory.
 */

import type {
  FinishReason,
  JsonObject,
  Message,
  ModelAdapter,
  ModelStreamOptions,
  ProviderState,
  StreamEvent,
  TokenUsage,
} from "@rejelly/core";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import { normalizeOpenAIUsage } from "./usage";
import {
  injectSchemaToMessages,
  toOpenAIMessages,
  toOpenAIToolChoice,
  toOpenAITools,
  wrapAsModelCallError,
} from "./utils";

type OpenAIRequestOption = NonNullable<Parameters<OpenAI["chat"]["completions"]["create"]>[1]>;

export type ChatCompletionParams = Partial<
  Omit<ChatCompletionCreateParamsStreaming, "stream" | "message" | "tools" | "tool_choice">
>;
export type RequestOption = Omit<OpenAIRequestOption, "signal">;

/**
 * How the response schema is delivered to the model.
 * - "prompt": inject the schema into the system prompt (widest compatibility).
 * - "json_object": send `response_format: { type: "json_object" }` AND inject the
 *   schema into the prompt. The API only guarantees syntactically valid JSON, not
 *   field-level conformance — the prompt carries the field contract (e.g. DeepSeek).
 * - "json_schema": send `response_format: { type: "json_schema", strict }` natively
 *   (OpenAI Structured Outputs); the model enforces the schema, no prompt injection.
 */
export type SchemaMode = "prompt" | "json_object" | "json_schema";

type StreamHandlerOptions = {
  schemaMode?: SchemaMode;
  chatCompletionParams?: ChatCompletionParams;
  requestOption?: RequestOption;
  modelStreamOption?: ModelStreamOptions;
};

type OpenAIReasoningDetail = JsonObject;

type OpenAIChoiceDeltaLike = {
  content?: string | Array<{ type?: string; text?: string }>;
  reasoning_content?: string;
  reasoning?:
    | string
    | { text?: string }
    | Array<{ text?: string; content?: string; type?: string }>;
  reasoning_details?: OpenAIReasoningDetail[];
};

const OPENAI_CHAT_PROTOCOL = "chat_completions";
const OPENAI_CHAT_STATE_VERSION = 1;

function createChatProviderState(
  provider: string | undefined,
  endpoint: string,
  reasoningDetails: OpenAIReasoningDetail[],
): ProviderState {
  return {
    provider: provider ?? "openai",
    protocol: OPENAI_CHAT_PROTOCOL,
    version: OPENAI_CHAT_STATE_VERSION,
    payload: { endpoint, reasoningDetails },
  };
}

function reasoningDetailKey(item: OpenAIReasoningDetail, position: number): string {
  if (typeof item.index === "number") return `index:${item.index}`;
  if (typeof item.id === "string" && item.id.length > 0) return `id:${item.id}`;
  return `position:${position}`;
}

function mergeReasoningDetail(
  current: OpenAIReasoningDetail | undefined,
  fragment: OpenAIReasoningDetail,
): OpenAIReasoningDetail {
  if (!current) return { ...fragment };
  const merged: OpenAIReasoningDetail = { ...current };
  for (const [key, value] of Object.entries(fragment)) {
    const previous = merged[key];
    if (
      typeof previous === "string" &&
      typeof value === "string" &&
      ["data", "signature", "summary", "text"].includes(key)
    ) {
      merged[key] = value.startsWith(previous) ? value : previous + value;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function extractReasoningFromDelta(delta: OpenAIChoiceDeltaLike | undefined): string | undefined {
  if (!delta) return undefined;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
    return delta.reasoning;
  }
  if (
    typeof delta.reasoning === "object" &&
    delta.reasoning !== null &&
    !Array.isArray(delta.reasoning) &&
    typeof delta.reasoning.text === "string" &&
    delta.reasoning.text.length > 0
  ) {
    return delta.reasoning.text;
  }
  if (Array.isArray(delta.reasoning)) {
    const text = delta.reasoning
      .map((item) => item.text ?? item.content ?? "")
      .filter((item) => item.length > 0)
      .join("");
    if (text.length > 0) return text;
  }
  if (Array.isArray(delta.content)) {
    const text = delta.content
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text ?? "")
      .filter((item) => item.length > 0)
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
}

function extractTextFromDelta(delta: OpenAIChoiceDeltaLike | undefined): string | undefined {
  if (!delta) return undefined;
  if (typeof delta.content === "string" && delta.content.length > 0) {
    return delta.content;
  }
  if (Array.isArray(delta.content)) {
    const text = delta.content
      .filter((part) => part.type === "text" || part.type === "output_text")
      .map((part) => part.text ?? "")
      .filter((item) => item.length > 0)
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
}

async function* streamHandler(
  client: OpenAI,
  modelId: string,
  provider: string | undefined,
  messages: Message[],
  options: StreamHandlerOptions,
): AsyncGenerator<StreamEvent> {
  const { schemaMode = "prompt", chatCompletionParams, requestOption, modelStreamOption } = options;

  const { schema, signal, tools, toolChoice, additionalOptions } = modelStreamOption || {};
  const requestController = new AbortController();
  const requestSignal = requestController.signal;
  const onAgentAbort = () => requestController.abort(signal?.reason);

  if (signal) {
    if (signal.aborted) {
      requestController.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAgentAbort);
    }
  }

  // Only json_schema lets the model enforce the schema natively; the other modes
  // (prompt, json_object) still need the schema in the prompt for field guidance.
  let finalMessages = messages;
  if (schema && schemaMode !== "json_schema") {
    finalMessages = injectSchemaToMessages(messages, schema);
  }

  const params: ChatCompletionCreateParamsStreaming = {
    model: modelId,
    messages: [],
    stream: true,
  };

  if (chatCompletionParams && Object.keys(chatCompletionParams).length > 0) {
    Object.assign(params, chatCompletionParams);
  }
  if (additionalOptions && Object.keys(additionalOptions).length > 0) {
    Object.assign(params, additionalOptions);
  }
  params.model = modelId;
  params.stream = true;
  params.messages = toOpenAIMessages(finalMessages, {
    provider,
    endpoint: client.baseURL,
  });
  params.stream_options = { include_usage: true };

  if (schema && schemaMode === "json_schema") {
    params.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema, strict: true },
    };
  } else if (schema && schemaMode === "json_object") {
    params.response_format = { type: "json_object" };
  }

  if (tools?.length) {
    params.tools = toOpenAITools(tools);
    if (toolChoice) params.tool_choice = toOpenAIToolChoice(toolChoice);
  }

  const allowedFinishReasons: FinishReason[] = [
    "stop",
    "length",
    "tool_calls",
    "content_filter",
    "error",
    "unknown",
  ];

  try {
    const stream = await client.chat.completions.create(params, {
      ...requestOption,
      signal: requestSignal,
    });

    const toolCallsMap = new Map<number, { id: string; name: string }>();
    const reasoningDetails = new Map<string, OpenAIReasoningDetail>();
    const reasoningDetailOrder: string[] = [];
    let lastUsage: TokenUsage | undefined;
    let lastFinishReason: FinishReason | undefined;

    for await (const chunk of stream) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const choice = (chunk as ChatCompletionChunk).choices[0];

      const delta = choice?.delta as OpenAIChoiceDeltaLike | undefined;
      const reasoning = extractReasoningFromDelta(delta);
      if (reasoning) {
        yield { type: "reasoning", content: reasoning };
      }

      const text = extractTextFromDelta(delta);
      if (text) {
        yield { type: "text", content: text };
      }

      for (const [position, detail] of (delta?.reasoning_details ?? []).entries()) {
        const key = reasoningDetailKey(detail, position);
        if (!reasoningDetails.has(key)) reasoningDetailOrder.push(key);
        reasoningDetails.set(key, mergeReasoningDetail(reasoningDetails.get(key), detail));
      }

      if (choice?.delta?.tool_calls) {
        for (const delta of choice.delta.tool_calls) {
          const index = delta.index;
          if (!toolCallsMap.has(index)) {
            toolCallsMap.set(index, {
              id: delta.id ?? "",
              name: delta.function?.name ?? "",
            });
          }
          const tc = toolCallsMap.get(index)!;
          if (delta.id) tc.id = delta.id;
          if (delta.function?.name) tc.name = delta.function.name;

          yield {
            type: "tool_call",
            toolCall: {
              index,
              id: tc.id,
              name: tc.name,
              arguments: delta.function?.arguments,
            },
          };
        }
      }

      if (chunk.usage) {
        lastUsage = normalizeOpenAIUsage(chunk.usage, "chat_completions");
        if (lastUsage) {
          yield { type: "usage", usage: lastUsage };
        }
      }

      const fr = choice?.finish_reason;
      if (fr !== undefined && fr !== null) {
        lastFinishReason = allowedFinishReasons.includes(fr as FinishReason)
          ? (fr as FinishReason)
          : "unknown";
      }
    }

    if (reasoningDetailOrder.length > 0) {
      const completeDetails = reasoningDetailOrder.flatMap((key) => {
        const detail = reasoningDetails.get(key);
        return detail ? [detail] : [];
      });
      yield {
        type: "state",
        state: createChatProviderState(provider, client.baseURL, completeDetails),
      };
    }

    yield {
      type: "finish",
      finishReason: lastFinishReason ?? "unknown",
      ...(lastUsage && { usage: lastUsage }),
    };
  } catch (error) {
    wrapAsModelCallError(error, modelId, provider, client.baseURL);
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAgentAbort);
    }
    // Ensure request-level signal listeners are always released after stream exits.
    requestController.abort("OpenAI stream completed");
  }
}

// ── Public API ──────────────────────────────────────────────

export interface OpenAIAdapterConfig {
  /** Optional custom id for the adapter. When omitted, modelId is used as-is (e.g. "gpt-4o"). Use to disambiguate when multiple providers serve the same model. */
  id?: string;
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  provider?: string;
  /**
   * How a response schema is delivered to the model. See {@link SchemaMode}.
   * - "prompt" (default): inject schema into the system prompt — widest compatibility
   *   for OpenAI-compatible LLMs that don't support a response_format.
   * - "json_object": send `response_format: { type: "json_object" }` plus prompt
   *   injection — for providers with a JSON mode but no strict schema (e.g. DeepSeek).
   * - "json_schema": OpenAI Structured Outputs (strict). Recommended for official
   *   OpenAI models; the schema must follow OpenAI's rules (e.g. object schemas should
   *   set additionalProperties: false where required).
   * @default "prompt"
   */
  schemaMode?: SchemaMode;
  /**
   * Optional cost calculator. If not provided, calculateCost returns {}.
   * Return integer amounts per billing unit (e.g. { micro_usd: 1500 }).
   */
  calculateCost?: (usage: TokenUsage) => Record<string, number>;
  /**
   * Optional default params for chat completions (e.g. temperature, max_tokens).
   * Merged into the request; model, messages, stream are set by the adapter.
   */
  chatCompletionParams?: ChatCompletionParams;
  /**
   * Optional request options for chat.completions.create (e.g. timeout).
   * Passed to the SDK call; signal is set by the adapter.
   */
  requestOption?: RequestOption;
}

export function createOpenAIAdapter(config: OpenAIAdapterConfig): ModelAdapter {
  const {
    id,
    modelId,
    apiKey,
    baseURL,
    provider,
    schemaMode = "prompt",
    calculateCost: calculateCostFn,
    chatCompletionParams,
    requestOption,
  } = config;

  if (!modelId?.trim()) {
    throw new Error("@rejelly/adapter-openai: modelId is required");
  }

  const client = new OpenAI({ apiKey, baseURL });

  return {
    id: id ?? modelId,
    provider,

    async *stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent> {
      const streamOptions: StreamHandlerOptions = {
        schemaMode,
        chatCompletionParams,
        requestOption,
        modelStreamOption: options,
      };
      yield* streamHandler(client, modelId, provider, messages, streamOptions);
    },

    calculateCost(usage: TokenUsage): Record<string, number> {
      return calculateCostFn ? calculateCostFn(usage) : {};
    },
  };
}
