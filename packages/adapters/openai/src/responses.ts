import type {
  FinishReason,
  JsonObject,
  JsonValue,
  Message,
  ModelStreamOptions,
  ProviderState,
  StreamEvent,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "@rejelly/core";
import type OpenAI from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseStreamEvent,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { RequestOption, SchemaMode } from "./adapter";
import { OPENAI_RESPONSES_STATE_KIND } from "./identity";
import { normalizeOpenAIUsage } from "./usage";
import { convertContentToString, injectSchemaToMessages, wrapAsModelCallError } from "./utils";

const OPENAI_RESPONSES_STATE_VERSION = 1;
const REQUIRED_INCLUDE = "reasoning.encrypted_content" as const;

export type ResponseParams = Partial<
  Omit<
    ResponseCreateParamsStreaming,
    "input" | "instructions" | "model" | "stream" | "tool_choice" | "tools"
  >
>;

type ResponsesStreamHandlerOptions = {
  schemaMode?: SchemaMode;
  responseParams?: ResponseParams;
  requestOption?: RequestOption;
  modelStreamOption?: ModelStreamOptions;
};

type ResponsesIdentity = {
  provider?: string;
  endpoint: string;
};

type FunctionCallProgress = {
  callId: string;
  name: string;
  arguments: string;
};

type CompatibleReasoningTextDelta = {
  type: "response.reasoning_text.delta";
  delta: string;
};

function getCompatibleReasoningTextDelta(event: ResponseStreamEvent): string | undefined {
  const candidate = event as unknown as Partial<CompatibleReasoningTextDelta>;
  return candidate.type === "response.reasoning_text.delta" && typeof candidate.delta === "string"
    ? candidate.delta
    : undefined;
}

function normalizedEndpoint(value: string): string {
  return value.replace(/\/+$/, "").toLowerCase();
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item) ?? null);
  }
  if (typeof value !== "object") return undefined;

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = toJsonValue(item);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  const normalized = toJsonValue(value);
  return normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : undefined;
}

function responsesStateFor(
  message: Message,
  identity: ResponsesIdentity,
): JsonObject[] | undefined {
  const state = message.provider_state?.find(
    (candidate) =>
      candidate.kind === OPENAI_RESPONSES_STATE_KIND &&
      candidate.version === OPENAI_RESPONSES_STATE_VERSION,
  );
  if (
    !state ||
    normalizedEndpoint(String(state.payload.endpoint ?? "")) !==
      normalizedEndpoint(identity.endpoint) ||
    state.payload.provider !== identity.provider
  ) {
    return undefined;
  }
  const outputItems = state.payload.outputItems;
  if (
    !Array.isArray(outputItems) ||
    !outputItems.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  ) {
    return undefined;
  }
  return outputItems as JsonObject[];
}

function inputContent(content: Message["content"]): ResponseInputMessageContentList {
  if (content === null || content === undefined) return [{ type: "input_text", text: "" }];
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text" as const, text: part.text };
    if (part.type === "image") {
      return {
        type: "input_image" as const,
        detail: part.image.detail ?? "auto",
        image_url: part.image.url,
      };
    }
    throw new Error(`Unsupported Responses input content part: ${part.type}`);
  });
}

function functionOutputContent(
  content: Message["content"],
): ResponseInputItem.FunctionCallOutput["output"] {
  if (!Array.isArray(content)) return convertContentToString(content) ?? "";
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text" as const, text: part.text };
    if (part.type === "image") {
      return {
        type: "input_image" as const,
        detail: part.image.detail ?? "auto",
        image_url: part.image.url,
      };
    }
    throw new Error(`Unsupported Responses function output content part: ${part.type}`);
  });
}

export function toOpenAIResponseInput(
  messages: Message[],
  identity: ResponsesIdentity,
): { instructions?: string; input: ResponseInputItem[] } {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = convertContentToString(message.content);
      if (text) instructions.push(text);
      continue;
    }

    if (message.role === "assistant") {
      const stateItems = responsesStateFor(message, identity);
      if (stateItems) {
        input.push(...(stateItems as unknown as ResponseInputItem[]));
        continue;
      }

      const text = convertContentToString(message.content);
      if (text !== null) {
        input.push({ role: "assistant", content: text } satisfies EasyInputMessage);
      }
      for (const toolCall of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        } satisfies ResponseFunctionToolCall);
      }
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: functionOutputContent(message.content),
      });
      continue;
    }

    input.push({ role: "user", content: inputContent(message.content) } satisfies EasyInputMessage);
  }

  return {
    ...(instructions.length > 0 && { instructions: instructions.join("\n\n") }),
    input,
  };
}

function toOpenAIResponseTools(tools: ToolDefinition[]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters, { $refStrategy: "none" }) as Record<
      string,
      unknown
    >,
    strict: true,
  }));
}

function toOpenAIResponseToolChoice(
  toolChoice: ToolChoice,
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "function", name: toolChoice.function.name };
  }
  return undefined;
}

function assertStatelessParams(params: ResponseCreateParamsStreaming): void {
  if (params.store !== undefined && params.store !== false) {
    throw new Error('@rejelly/adapter-openai: Responses stateless mode requires "store: false"');
  }
  if (params.previous_response_id) {
    throw new Error(
      '@rejelly/adapter-openai: Responses stateless mode does not support "previous_response_id"',
    );
  }
  if (params.conversation) {
    throw new Error(
      '@rejelly/adapter-openai: Responses stateless mode does not support "conversation"',
    );
  }
  if (params.background) {
    throw new Error(
      "@rejelly/adapter-openai: Responses streaming does not support background mode",
    );
  }
  if (
    params.include !== undefined &&
    params.include !== null &&
    !params.include.includes(REQUIRED_INCLUDE)
  ) {
    throw new Error(
      `@rejelly/adapter-openai: Responses stateless mode requires include: ["${REQUIRED_INCLUDE}"]`,
    );
  }
  if (params.include === null) {
    throw new Error(
      `@rejelly/adapter-openai: Responses stateless mode requires include: ["${REQUIRED_INCLUDE}"]`,
    );
  }
}

function createResponsesProviderState(
  identity: ResponsesIdentity,
  response: Response,
): ProviderState | undefined {
  const outputItems = response.output.map(toJsonObject);
  if (outputItems.some((item) => item === undefined)) return undefined;
  return {
    kind: OPENAI_RESPONSES_STATE_KIND,
    version: OPENAI_RESPONSES_STATE_VERSION,
    payload: {
      endpoint: identity.endpoint,
      ...(identity.provider !== undefined && { provider: identity.provider }),
      responseId: response.id,
      outputItems: outputItems as JsonObject[],
    },
  };
}

function responseFailureMessage(response: Response): string {
  return (
    response.error?.message ?? response.incomplete_details?.reason ?? "Responses request failed"
  );
}

function finishReasonFor(response: Response): FinishReason {
  return response.output.some((item) => item.type === "function_call") ? "tool_calls" : "stop";
}

function usageFrom(response: Response): TokenUsage | undefined {
  return normalizeOpenAIUsage(response.usage, "responses");
}

export async function* streamResponses(
  client: OpenAI,
  modelId: string,
  provider: string | undefined,
  messages: Message[],
  options: ResponsesStreamHandlerOptions,
): AsyncGenerator<StreamEvent> {
  const { schemaMode = "prompt", responseParams, requestOption, modelStreamOption } = options;
  const { schema, signal, tools, toolChoice, additionalOptions } = modelStreamOption ?? {};
  const requestController = new AbortController();
  const onAgentAbort = () => requestController.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) requestController.abort(signal.reason);
    else signal.addEventListener("abort", onAgentAbort);
  }

  let finalMessages = messages;
  if (schema && schemaMode !== "json_schema") {
    finalMessages = injectSchemaToMessages(messages, schema);
  }
  const identity = { provider, endpoint: client.baseURL };
  const converted = toOpenAIResponseInput(finalMessages, identity);
  const params = {
    ...responseParams,
    ...additionalOptions,
    model: modelId,
    input: converted.input,
    stream: true,
  } as ResponseCreateParamsStreaming;

  assertStatelessParams(params);
  params.store = false;
  params.include = [...new Set([...(params.include ?? []), REQUIRED_INCLUDE])];
  params.instructions = converted.instructions;
  if (schema && schemaMode === "json_schema") {
    params.text = {
      ...params.text,
      format: { type: "json_schema", name: "response", schema, strict: true },
    };
  } else if (schema && schemaMode === "json_object") {
    params.text = { ...params.text, format: { type: "json_object" } };
  }
  if (tools?.length) {
    params.tools = toOpenAIResponseTools(tools);
    if (toolChoice) params.tool_choice = toOpenAIResponseToolChoice(toolChoice);
  }

  const calls = new Map<number, FunctionCallProgress>();
  let terminal = false;

  try {
    const stream = await client.responses.create(params, {
      ...requestOption,
      signal: requestController.signal,
    });

    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const compatibleReasoningDelta = getCompatibleReasoningTextDelta(event);
      if (compatibleReasoningDelta) {
        yield { type: "reasoning", content: compatibleReasoningDelta };
        continue;
      }

      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text", content: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
          if (event.delta) yield { type: "reasoning", content: event.delta };
          break;
        case "response.output_item.added":
          if (event.item.type === "function_call") {
            const call = {
              callId: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            };
            calls.set(event.output_index, call);
            yield {
              type: "tool_call",
              toolCall: {
                index: event.output_index,
                id: call.callId,
                name: call.name,
                arguments: call.arguments,
              },
            };
          }
          break;
        case "response.function_call_arguments.delta": {
          const call = calls.get(event.output_index);
          if (call) call.arguments += event.delta;
          yield {
            type: "tool_call",
            toolCall: {
              index: event.output_index,
              id: call?.callId ?? event.item_id,
              name: call?.name ?? "",
              arguments: event.delta,
            },
          };
          break;
        }
        case "response.output_item.done":
          if (event.item.type === "function_call") {
            const call = calls.get(event.output_index);
            const seen = call?.arguments ?? "";
            const missing = event.item.arguments.startsWith(seen)
              ? event.item.arguments.slice(seen.length)
              : seen.length === 0
                ? event.item.arguments
                : "";
            if (missing) {
              yield {
                type: "tool_call",
                toolCall: {
                  index: event.output_index,
                  id: event.item.call_id,
                  name: event.item.name,
                  arguments: missing,
                },
              };
            }
          }
          break;
        case "response.completed": {
          terminal = true;
          const usage = usageFrom(event.response);
          if (usage) yield { type: "usage", usage };
          const state = createResponsesProviderState(identity, event.response);
          if (state) yield { type: "state", state };
          yield {
            type: "finish",
            finishReason: finishReasonFor(event.response),
            ...(usage && { usage }),
          };
          break;
        }
        case "response.incomplete": {
          terminal = true;
          const usage = usageFrom(event.response);
          if (usage) yield { type: "usage", usage };
          yield { type: "finish", finishReason: "length", ...(usage && { usage }) };
          break;
        }
        case "response.failed":
          terminal = true;
          throw new Error(responseFailureMessage(event.response));
        case "error":
          terminal = true;
          throw new Error(event.message);
      }
    }

    if (!terminal) {
      throw new Error("Responses stream ended without a terminal event");
    }
  } catch (error) {
    wrapAsModelCallError(error, modelId, provider, client.baseURL);
  } finally {
    if (signal) signal.removeEventListener("abort", onAgentAbort);
    requestController.abort("OpenAI Responses stream completed");
  }
}
