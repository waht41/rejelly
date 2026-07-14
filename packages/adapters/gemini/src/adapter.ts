/**
 * Gemini adapter: SDK instantiation and stream request orchestration.
 */

import {
  type Content,
  FinishReason as GeminiFinishReason,
  type GenerateContentConfig,
  type GenerateContentParameters,
  GoogleGenAI,
  type HttpOptions,
  type Part,
  type ToolConfig,
} from "@google/genai";
import type {
  FinishReason,
  Message,
  ModelAdapter,
  ModelStreamOptions,
  StreamEvent,
  TokenUsage,
} from "@rejelly/core";
import { wrapAsModelCallError } from "./error";
import {
  extractSystemInstruction,
  generateSchemaInstruction,
  toGeminiMessages,
  toGeminiToolChoice,
  toGeminiTools,
} from "./utils";

/** Extra config for generateContent/generateContentStream (safetySettings, cachedContent, thinkingConfig, etc.) */
export type GenerateContentParams = GenerateContentConfig;

export type GeminiRequestOption = HttpOptions;

/**
 * How the response schema is delivered to the model.
 * - "prompt": inject the schema into `systemInstruction` (widest compatibility).
 * - "json_object": set `responseMimeType: "application/json"` AND inject the schema
 *   into the prompt. Forces JSON output without strict field enforcement.
 * - "json_schema": set `responseMimeType` + `responseSchema` natively; Gemini enforces
 *   the schema, no prompt injection.
 */
export type SchemaMode = "prompt" | "json_object" | "json_schema";

interface ExtendedStreamOptions extends ModelStreamOptions {
  schemaMode?: SchemaMode;
  generateContentParams?: GenerateContentParams;
}

function getEnvApiKey(): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

/** Map Gemini SDK FinishReason to @rejelly/core FinishReason for stream protocol. */
function mapGeminiFinishReason(reason: GeminiFinishReason | undefined): FinishReason {
  switch (reason) {
    case GeminiFinishReason.STOP:
      return "stop";
    case GeminiFinishReason.MAX_TOKENS:
      return "length";
    case GeminiFinishReason.SAFETY:
      return "content_filter";
    default:
      return "unknown";
  }
}

function splitGeminiTextParts(parts: Part[] | undefined): {
  text: string;
  reasoning: string;
} {
  if (!parts || parts.length === 0) {
    return { text: "", reasoning: "" };
  }

  let text = "";
  let reasoning = "";
  for (const part of parts) {
    if (typeof part.text !== "string" || part.text.length === 0) continue;
    if (part.thought) {
      reasoning += part.text;
    } else {
      text += part.text;
    }
  }

  return { text, reasoning };
}

async function* streamHandler(
  genAI: GoogleGenAI,
  modelId: string,
  messages: Message[],
  options: ExtendedStreamOptions,
): AsyncGenerator<StreamEvent> {
  const {
    schema,
    signal,
    tools,
    toolChoice,
    schemaMode = "prompt",
    generateContentParams,
  } = options;
  const additionalOptions = options?.additionalOptions;
  let rejectOnAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const requestController = new AbortController();
  const requestSignal = requestController.signal;
  const onAgentAbort = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("AbortError");
    requestController.abort(reason);
    rejectOnAbort?.(reason);
  };

  if (signal) {
    if (signal.aborted) {
      onAgentAbort();
    } else {
      signal.addEventListener("abort", onAgentAbort);
    }
  }

  let systemInstruction: string | Content | undefined = await extractSystemInstruction(messages);

  // Only json_schema lets Gemini enforce the schema natively; the other modes
  // (prompt, json_object) still need the schema in the prompt for field guidance.
  if (schema && schemaMode !== "json_schema") {
    const schemaInstruction = generateSchemaInstruction(schema as Record<string, unknown>);
    if (typeof systemInstruction === "string") {
      systemInstruction = systemInstruction
        ? `${systemInstruction}\n\n${schemaInstruction}`
        : schemaInstruction;
    } else if (systemInstruction && "parts" in systemInstruction) {
      systemInstruction = {
        ...systemInstruction,
        parts: [...(systemInstruction.parts ?? []), { text: schemaInstruction }],
      };
    } else {
      systemInstruction = schemaInstruction;
    }
  }

  const allContent = await toGeminiMessages(messages);
  const geminiTools = tools && tools.length > 0 ? toGeminiTools(tools) : undefined;
  const requestConfig: Partial<GenerateContentConfig> = {};

  if (additionalOptions && Object.keys(additionalOptions).length > 0) {
    Object.assign(requestConfig, additionalOptions);
  }

  // json_object and json_schema both force JSON output; only json_schema also
  // pins the schema natively (json_object relies on the injected prompt for fields).
  if (schema && schemaMode !== "prompt") {
    requestConfig.responseMimeType = "application/json";
    if (schemaMode === "json_schema") {
      requestConfig.responseSchema = schema as GenerateContentConfig["responseSchema"];
    }
  }

  let toolConfig: ToolConfig | undefined;

  if (toolChoice) {
    const choice = toGeminiToolChoice(toolChoice);
    if (choice) {
      toolConfig = {
        functionCallingConfig: {
          mode: choice,
        },
      };
    }
  }

  if (allContent.length === 0) {
    throw new Error("No message to send");
  }

  const request: GenerateContentParameters = {
    model: modelId,
    contents: allContent,
    config: {
      ...generateContentParams,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(geminiTools ? { tools: geminiTools } : {}),
      ...(toolConfig ? { toolConfig } : {}),
      ...requestConfig,
      abortSignal: requestSignal,
    },
  };

  try {
    const streamPromise = genAI.models.generateContentStream(request);
    const stream = (await Promise.race([streamPromise, abortPromise])) as Awaited<
      typeof streamPromise
    >;

    let lastUsage: TokenUsage | undefined;
    let lastFinishReason: FinishReason | undefined;
    let functionCallIndex = 0;

    function stringifyGeminiFunctionArgs(args: unknown): string {
      if (typeof args === "string") return args;
      try {
        return JSON.stringify(args ?? {});
      } catch {
        return "{}";
      }
    }

    function requireToolCallId(call: { id?: string }): string {
      if (typeof call.id === "string" && call.id.length > 0) {
        return call.id;
      }
      throw new Error("Gemini functionCall.id is required but missing");
    }

    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      // @google/genai may not reliably interrupt a pending AsyncIterator read on abort,
      // and aborting the client-side stream does not imply server-side generation (or billing) stops.
      const result = await Promise.race([iterator.next(), abortPromise]);
      if (result.done) {
        break;
      }
      const chunk = result.value;
      const candidateParts = chunk.candidates?.[0]?.content?.parts as Part[] | undefined;
      const splitParts = splitGeminiTextParts(candidateParts);
      const emittedFromParts = splitParts.text.length > 0 || splitParts.reasoning.length > 0;
      const callParts =
        candidateParts?.filter(
          (part) =>
            part.functionCall &&
            typeof part.functionCall.name === "string" &&
            part.functionCall.name.length > 0,
        ) ?? [];
      const functionCalls = callParts.length > 0 ? undefined : chunk.functionCalls;
      const hasFunctionCall =
        callParts.length > 0 || (functionCalls !== undefined && functionCalls.length > 0);

      if (splitParts.reasoning) {
        yield { type: "reasoning", content: splitParts.reasoning };
      }
      if (splitParts.text) {
        yield { type: "text", content: splitParts.text };
      }

      // In newer @google/genai versions, reading chunk.text getter on pure functionCall chunks
      // triggers a warning. Only read text when there are no function calls.
      if (!emittedFromParts && !hasFunctionCall) {
        let text = "";
        if (typeof chunk.text === "string") {
          text = chunk.text;
        }
        if (text) {
          yield { type: "text", content: text };
        }
      }

      if (callParts.length > 0) {
        for (const part of callParts) {
          const call = part.functionCall!;
          const thoughtSignature = part.thoughtSignature;
          const currentIndex = functionCallIndex++;
          const toolCallId = requireToolCallId(call as { id?: string });
          yield {
            type: "tool_call",
            toolCall: {
              index: currentIndex,
              id: toolCallId,
              name: call.name,
              arguments: stringifyGeminiFunctionArgs(call.args),
              ...(typeof thoughtSignature === "string" && thoughtSignature.length > 0
                ? { extra: { thoughtSignature } }
                : {}),
            },
          };
        }
      } else {
        if (functionCalls && functionCalls.length > 0) {
          for (const call of functionCalls) {
            const currentIndex = functionCallIndex++;
            const toolCallId = requireToolCallId(call as { id?: string });
            // Fallback path for SDK variants where candidate parts are unavailable.
            yield {
              type: "tool_call",
              toolCall: {
                index: currentIndex,
                id: toolCallId,
                name: call.name,
                arguments: stringifyGeminiFunctionArgs(call.args),
              },
            };
          }
        }
      }

      if (chunk.usageMetadata) {
        const reasoningTokens = chunk.usageMetadata.thoughtsTokenCount;
        lastUsage = {
          promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          completionTokens:
            (chunk.usageMetadata.candidatesTokenCount ?? 0) + (reasoningTokens ?? 0),
          totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
        };

        if (reasoningTokens !== undefined) {
          lastUsage.details = {
            reasoningTokens,
          };
        }
      }

      const candidateFinishReason = chunk.candidates?.[0]?.finishReason as
        | GeminiFinishReason
        | undefined;
      if (candidateFinishReason !== undefined) {
        lastFinishReason = mapGeminiFinishReason(candidateFinishReason);
      }
    }

    if (lastUsage) {
      yield { type: "usage", usage: lastUsage };
    }

    yield {
      type: "finish",
      finishReason: lastFinishReason ?? "unknown",
      ...(lastUsage && { usage: lastUsage }),
    };
  } catch (err) {
    wrapAsModelCallError(err, modelId);
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAgentAbort);
    }
    // Ensure request-level signal listeners are always released after stream exits.
    requestController.abort("Gemini stream completed");
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface GeminiAdapterConfig {
  /** Optional custom id for the adapter. When omitted, modelId is used as-is (e.g. "gemini-1.5-pro"). Use to disambiguate when multiple providers serve the same model. */
  id?: string;
  modelId: string;
  apiKey?: string;
  /**
   * How a response schema is delivered to the model. See {@link SchemaMode}.
   * - "json_schema" (default): pass responseMimeType + responseSchema natively
   *   (e.g. Gemini 1.5 Pro); Gemini enforces the schema.
   * - "json_object": force JSON output via responseMimeType only, with the schema
   *   injected into the prompt for field guidance.
   * - "prompt": inject the schema into the system prompt, no responseMimeType.
   * @default "json_schema"
   */
  schemaMode?: SchemaMode;
  /**
   * Optional cost calculator. If not provided, calculateCost returns {}.
   * Return integer amounts per billing unit (e.g. { micro_usd: 1500 }).
   */
  calculateCost?: (usage: TokenUsage) => Record<string, number>;

  /** Extra params for generateContentStream (safetySettings, cachedContent, etc.) */
  generateContentParams?: GenerateContentParams;

  requestOption?: GeminiRequestOption;
}

export function createGeminiAdapter(config: GeminiAdapterConfig): ModelAdapter {
  const {
    id,
    modelId,
    apiKey = getEnvApiKey(),
    schemaMode = "json_schema",
    calculateCost: calculateCostFn,
    generateContentParams,
    requestOption,
  } = config;

  if (!modelId?.trim()) {
    throw new Error("@rejelly/adapter-gemini: modelId is required");
  }

  if (!apiKey) {
    throw new Error(
      "Gemini API key is required. Set apiKey in config or GEMINI_API_KEY / GOOGLE_API_KEY env (Node only). In browser, pass apiKey in config.",
    );
  }

  const genAI = new GoogleGenAI({
    apiKey,
    ...(requestOption ? { httpOptions: requestOption } : {}),
  });

  return {
    id: id ?? modelId,
    provider: "gemini",

    async *stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent> {
      yield* streamHandler(genAI, modelId, messages, {
        ...options,
        schemaMode,
        generateContentParams,
      });
    },

    calculateCost(usage: TokenUsage): Record<string, number> {
      return calculateCostFn ? calculateCostFn(usage) : {};
    },
  };
}
