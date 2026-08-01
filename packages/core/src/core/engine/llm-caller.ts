/**
 * LLM Caller
 *
 * Core function for calling LLM and processing streaming response.
 */

import { startTimer } from "../../utils/clock";
import { safeParse } from "../../utils/safe-json-parser";
import { getCurrentContextSafe } from "../context/accessor";
import type { CallLLMOptions } from "../context/type";
import { toErrorInfo } from "../domain/errors";
import type {
  FinishReason,
  JsonSchema,
  Message,
  ModelAdapter,
  TokenUsage,
  ToolCall,
  ToolCallChunk,
} from "../domain/model";
import { withSpan } from "../observability/trace";
import { kModelMiddlewares } from "../shared/symbols";
import { recordLLMUsage } from "./budget-system";
import { emitStreamEvent } from "./effect";
import { cleanLLMResponse, validatePartialSchema } from "./validation";

interface PartialParseResult {
  partialData: Partial<unknown>;
  parsed: boolean;
}

/**
 * Parse partial structured data from the current stream buffer.
 * When skipParseIfEmpty is true and fullText is empty, skips JSON parse (e.g. during reasoning-only phase).
 */
function parsePartialStructuredData(options: {
  fullText: string;
  skipParseIfEmpty?: boolean;
  /** Target response JSON Schema; when set, parsed is true only if partial keys match object properties. */
  schema?: JsonSchema;
}): PartialParseResult {
  const { fullText, skipParseIfEmpty, schema } = options;

  let partialData: Partial<unknown> = {};
  let parsed = false;

  const shouldParse = !skipParseIfEmpty || fullText.length > 0;
  if (shouldParse) {
    try {
      const cleanedText = cleanLLMResponse(fullText);
      const rawParsed = safeParse(cleanedText) as unknown;

      if (rawParsed !== null && typeof rawParsed === "object") {
        partialData = rawParsed as Partial<unknown>;

        if (schema) {
          parsed = validatePartialSchema(partialData, schema);
        } else {
          parsed = true;
        }
        if (!parsed) {
          partialData = {};
        }
      } else {
        parsed = false;
        partialData = {};
      }
    } catch {
      parsed = false;
      partialData = {};
    }
  }

  return { partialData, parsed };
}

function createLLMStreamEmitter(options: {
  ctx: ReturnType<typeof getCurrentContextSafe>;
  turnIndex: number;
  schema?: JsonSchema;
  channel?: string;
}) {
  const { ctx, turnIndex, schema, channel } = options;

  const emitPartialStructuredData = (payload: {
    fullText: string;
    completed: boolean;
    skipParseIfEmpty?: boolean;
  }): void => {
    if (!ctx) {
      return;
    }

    const result = parsePartialStructuredData({
      fullText: payload.fullText,
      skipParseIfEmpty: payload.skipParseIfEmpty,
      schema,
    });

    // Schema-less chat may still expose structured snapshots when its text is a JSON object,
    // but ordinary prose failing an optional parse is not a structured-output error.
    if (!schema && !result.parsed) {
      return;
    }

    emitStreamEvent(ctx, {
      type: "structured_data",
      turnIndex,
      channel,
      status: payload.completed ? (result.parsed ? "complete" : "error") : "partial",
      data: result.partialData,
      isValid: result.parsed,
    });
  };

  return {
    emitTextDelta(delta: string): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "text",
        turnIndex,
        channel,
        delta,
      });
    },
    emitReasoningDelta(delta: string): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "reasoning",
        turnIndex,
        channel,
        delta,
      });
    },
    emitToolCallStream(chunk: ToolCallChunk): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "tool_call_stream",
        turnIndex,
        channel,
        chunk,
      });
    },
    emitExtra(extra: Record<string, unknown>): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "extra",
        turnIndex,
        channel,
        extra,
      });
    },
    emitUsage(usagePayload: TokenUsage): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "usage",
        turnIndex,
        channel,
        usage: usagePayload,
      });
    },
    emitError(error: unknown): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "error",
        turnIndex,
        channel,
        error,
      });
    },
    emitToolCall(toolCall: ToolCall): void {
      if (!ctx) return;
      emitStreamEvent(ctx, {
        type: "tool_call",
        turnIndex,
        channel,
        toolCall,
      });
    },
    emitPartialStructuredData,
  };
}

/**
 * Result of callLLM
 */
export interface LLMCallResult {
  text: string;
  /** Accumulated reasoning/thinking content from chain-of-thought models (e.g. DeepSeek-R1) */
  reasoning?: string;
  /** Message-level adapter/provider metadata merged from stream extra events. */
  extra?: Record<string, unknown>;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
  /** Time to first token in ms (from request start to first content chunk) */
  ttft?: number;
  /** Why the model stopped (e.g. stop, length, tool_calls) */
  finishReason?: FinishReason;
}

/**
 * Call LLM Implementation
 *
 * Pure business logic: handles streaming processing including:
 * - Text chunk concatenation
 * - Tool call buffer assembly (handles fragmented chunks)
 * - Stream event emission (text / structured_data / tool_call / usage, etc.)
 * - Usage statistics collection
 *
 */
async function _callLLM(
  model: ModelAdapter,
  messages: Message[],
  options: CallLLMOptions,
): Promise<LLMCallResult> {
  let fullText = "";
  let fullReasoning = "";
  let usage: TokenUsage | undefined;
  let finishReason: FinishReason | undefined;
  let messageExtra: Record<string, unknown> | undefined;
  let streamErrorEmitted = false;

  const sinceStreamStart = startTimer();
  let ttftMs: number | null = null;

  // Tool call buffer: handles fragmented tool_call chunks
  // key = index, value = { id, name, arguments, extra }
  const toolCallBuffer = new Map<
    number,
    { id: string; name: string; arguments: string; extra?: Record<string, unknown> }
  >();

  const {
    schema,
    signal,
    tools,
    toolChoice,
    additionalOptions,
    turnIndex = 0,
    channel,
  } = options ?? {};
  const ctx = getCurrentContextSafe();
  const streamEmitter = createLLMStreamEmitter({
    ctx,
    turnIndex,
    schema,
    channel,
  });

  try {
    for await (const event of model.stream(messages, {
      schema,
      signal,
      tools,
      toolChoice,
      additionalOptions,
    })) {
      // Handle different event types
      if (event.type === "text") {
        if (ttftMs === null) ttftMs = sinceStreamStart();
        fullText += event.content;

        streamEmitter.emitPartialStructuredData({
          fullText,
          completed: false,
        });
        streamEmitter.emitTextDelta(event.content);
      } else if (event.type === "reasoning") {
        if (ttftMs === null) ttftMs = sinceStreamStart();
        fullReasoning += event.content;
        streamEmitter.emitReasoningDelta(event.content);
        streamEmitter.emitPartialStructuredData({
          fullText,
          completed: false,
          skipParseIfEmpty: true,
        });
      } else if (event.type === "tool_call") {
        if (ttftMs === null) ttftMs = sinceStreamStart();
        const chunk = event.toolCall;
        const { index, id, name, arguments: args, extra } = chunk;
        streamEmitter.emitToolCallStream(chunk);

        // Get or create buffer for this index
        let buffer = toolCallBuffer.get(index);
        if (!buffer) {
          buffer = { id: "", name: "", arguments: "" };
          toolCallBuffer.set(index, buffer);
        }

        // Incremental concatenation
        if (id) buffer.id = id;
        if (name) buffer.name = name;
        if (args) buffer.arguments += args;
        if (extra && Object.keys(extra).length > 0) {
          buffer.extra = { ...(buffer.extra ?? {}), ...extra };
        }
      } else if (event.type === "extra") {
        // Message-level metadata uses shallow merge with last-write-wins semantics.
        messageExtra = { ...(messageExtra ?? {}), ...event.extra };
        streamEmitter.emitExtra(event.extra);
        streamEmitter.emitPartialStructuredData({
          fullText,
          completed: false,
          skipParseIfEmpty: true,
        });
      } else if (event.type === "usage") {
        usage = event.usage;
        streamEmitter.emitUsage(event.usage);
      } else if (event.type === "finish") {
        if (event.usage !== undefined) usage = event.usage;
        finishReason = event.finishReason;
      } else if (event.type === "error") {
        streamEmitter.emitError(event.error);
        streamErrorEmitted = true;
        throw event.error;
      }
    }
  } catch (error) {
    if (!streamErrorEmitted) {
      streamEmitter.emitError(error);
    }
    throw error;
  }

  streamEmitter.emitPartialStructuredData({
    fullText,
    completed: true,
  });

  // Assemble tool call results
  let toolCalls: ToolCall[] | undefined;
  if (toolCallBuffer.size > 0) {
    toolCalls = Array.from(toolCallBuffer.entries())
      .sort(([a], [b]) => a - b) // Sort by index
      .map(([, buffer]) => ({
        id: buffer.id,
        name: buffer.name,
        arguments: buffer.arguments,
        ...(buffer.extra && Object.keys(buffer.extra).length > 0 ? { extra: buffer.extra } : {}),
      }));
    if (ctx) {
      for (const toolCall of toolCalls) {
        streamEmitter.emitToolCall(toolCall);
      }
    }
  }

  // Record usage after LLM call
  if (ctx) {
    recordLLMUsage(ctx, model, usage);
  }

  const ttft = ttftMs ?? undefined;

  return {
    text: fullText,
    reasoning: fullReasoning || undefined,
    extra: messageExtra && Object.keys(messageExtra).length > 0 ? messageExtra : undefined,
    usage,
    toolCalls,
    ttft,
    finishReason,
  };
}

/**
 * Call LLM wrapper with tracing scope
 *
 * Wrapper that handles:
 * - Scope creation for trace hierarchy
 * - model:call:start/end events
 *
 * @param model - Model adapter
 * @param messages - Messages to send
 * @param options - Call options
 * @returns LLM call result
 */
export async function callLLM(
  model: ModelAdapter,
  messages: Message[],
  options: CallLLMOptions,
): Promise<LLMCallResult> {
  const ctx = getCurrentContextSafe();

  // No context, call directly without tracing
  if (!ctx) {
    return _callLLM(model, messages, options);
  }

  return withSpan("model-call", async (emitter) => {
    const elapsed = startTimer();
    const usedTools = options?.tools !== undefined && options.tools.length > 0;
    const middlewares = (
      model as unknown as {
        [kModelMiddlewares]?: { name: string; config?: Record<string, unknown> }[];
      }
    )[kModelMiddlewares]?.map((mw) => ({
      name: mw.name,
      config: mw.config,
    }));

    emitter?.modelCallStart({
      adapterId: model.id,
      provider: model.provider,
      messageCount: messages.length,
      usedTools,
      middlewares,
    });

    let result: LLMCallResult | undefined;
    let caughtError: Error | undefined;

    try {
      result = await _callLLM(model, messages, options);

      emitter?.modelCallEnd({
        adapterId: model.id,
        provider: model.provider,
        messageCount: messages.length,
        usedTools,
        middlewares,
        rawText: result.text,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
        duration: elapsed(),
        ttft: result.ttft,
        usage: result.usage,
        costs: model.calculateCost && result.usage ? model.calculateCost(result.usage) : undefined,
        finishReason: result.finishReason,
        success: true,
      });

      return result;
    } catch (error) {
      caughtError = error as Error;

      emitter?.modelCallEnd({
        adapterId: model.id,
        provider: model.provider,
        messageCount: messages.length,
        usedTools,
        middlewares,
        rawText: "",
        duration: elapsed(),
        success: false,
        finishReason: "error",
        error: toErrorInfo(caughtError),
      });

      throw error;
    }
  });
}
