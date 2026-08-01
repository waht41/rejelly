import { startTimer } from "../../utils/clock";
import { hashValue } from "../../utils/hash";
import { getCurrentContextSafe } from "../context/accessor";
import { ModelNotFoundError, TurnBudgetExceededError, toErrorInfo } from "../domain/errors";
import type { TurnToolConfig } from "../domain/event-payload";
import type { FinishReason, JsonSchema, Message } from "../domain/model";
import { assertUniqueToolNames, type ToolChoice, type ToolDefinition } from "../domain/tool";
import { toolDefinitionsToToolSchemas } from "../observability/tool-schema";
import { withSpan } from "../observability/trace";
import { generateCallId } from "../snapshot/id";
import { getJournalEntry, recordJournal } from "../snapshot/journal";
import { findModelInContextChain } from "./chain";
import { emitStreamEvent } from "./effect";
import { callLLM, type LLMCallResult } from "./llm-caller";
import { assertRuntimeUsable, type PromptRuntime } from "./runtime";

export interface ExecuteTurnOptions {
  jsonSchema?: JsonSchema;
  /**
   * Forked runtime for this turn — required. It must be derived (via `fork()`)
   * from the `PromptContext` handed to the active policy handler; anything else
   * throws `InvalidPromptRuntimeError`. `executeTurn` reads only `tools` from
   * it; pass the SAME runtime to the paired `executeTools` so the offered tool
   * set equals the executed one.
   */
  runtime: PromptRuntime;
  toolChoice?: ToolChoice;
  /**
   * Per-turn escape hatch for provider-specific stream options (temperature, …),
   * forwarded verbatim to `model.stream()`. Generation-wide params usually belong
   * on the model adapter; use this only to override for a single turn.
   */
  additionalOptions?: Record<string, unknown>;
  /**
   * Stream-event channel tag for this turn (see `AgentStreamEventBase.channel`). Set a named
   * channel on internal side-turns (e.g. context-compaction summarization) whose output must not
   * render as the agent's reply; leave unset for main conversation turns.
   */
  channel?: string;
}

/**
 * Single turn execution result.
 *
 * The output of a turn is a standard assistant `Message`:
 * - text-only response: `{ role: "assistant", content: string | null }`
 * - tool calls: `{ role: "assistant", content, tool_calls: [...] }`
 *
 * Downstream code can simply append `message` to the conversation history
 * and inspect `message.tool_calls` to drive the agent loop.
 */
export interface TurnExecutionResult {
  message: Message;
  isCacheHit: boolean;
  contentHash: string;
}

function buildTurnToolConfig(
  tools: ToolDefinition[],
  toolChoice: ToolChoice | undefined,
): TurnToolConfig | undefined {
  if (tools.length === 0) return undefined;
  return {
    tools: toolDefinitionsToToolSchemas(tools),
    toolChoice,
  };
}

function messageFromLLMResult(llmResult: LLMCallResult): Message {
  const message: Message = {
    role: "assistant",
    content: llmResult.text || null,
  };
  if (llmResult.reasoning) {
    message.reasoning_content = llmResult.reasoning;
  }
  if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
    message.tool_calls = llmResult.toolCalls;
  }
  if (llmResult.extra && Object.keys(llmResult.extra).length > 0) {
    message.extra = llmResult.extra;
  }
  return message;
}

function messageFromJournalOutput(output: unknown): Message {
  // Backwards compatibility: legacy journals stored plain strings for
  // content-only turns. Promote them to a proper assistant Message.
  if (typeof output === "string") {
    return { role: "assistant", content: output };
  }
  // Newer journals persist the full assistant Message directly.
  return output as Message;
}

function emitTurnEndSuccess(
  emitter: Parameters<Parameters<typeof withSpan>[1]>[0],
  step: number,
  messages: Message[],
  options: ExecuteTurnOptions,
  tools: ToolDefinition[],
  message: Message,
  hash: string,
  isCache: boolean,
  duration: number,
) {
  const toolCalls = message.tool_calls;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;

  const baseEvent = {
    step,
    messages,
    schema: options.jsonSchema,
    toolConfig: buildTurnToolConfig(tools, options.toolChoice),
    messageCount: messages.length,
    message,
    duration,
    success: true as const,
    contentHash: hash,
    cache: isCache,
  };

  if (hasToolCalls) {
    emitter?.turnEnd({
      ...baseEvent,
      resultType: "tool_calls",
    });
  } else {
    emitter?.turnEnd({
      ...baseEvent,
      resultType: "content",
    });
  }
}

export async function executeTurn(
  messages: Message[],
  options: ExecuteTurnOptions,
): Promise<TurnExecutionResult> {
  const ctx = getCurrentContextSafe()!;
  // Gate before consuming budget: a dead or foreign runtime must not burn a turn slot.
  assertRuntimeUsable(options?.runtime, ctx, "executeTurn");
  const model = findModelInContextChain(ctx);
  if (!model) throw new ModelNotFoundError();
  if (ctx.draft.steps >= ctx.maxTurnSteps) {
    throw new TurnBudgetExceededError(ctx.maxTurnSteps, ctx.draft.steps);
  }
  const turnTools = options.runtime.tools;
  assertUniqueToolNames(turnTools, "executeTurn");
  const callId = generateCallId(ctx, "prompt", "prompt");
  const modelInfo = {
    id: model.id,
    ...(model.provider !== undefined ? { provider: model.provider } : {}),
  };
  const step = ctx.draft.steps;
  ctx.draft.steps += 1;
  const turnInputHash = hashValue([
    messages,
    options.jsonSchema ?? null,
    modelInfo,
    toolDefinitionsToToolSchemas(turnTools),
  ]);

  return withSpan(`turn-${step}`, async (emitter) => {
    const elapsed = startTimer();
    emitStreamEvent(ctx, {
      type: "turn_start",
      turnIndex: step,
      channel: options.channel,
    });
    emitter?.turnStart({
      step,
      messages,
      schema: options.jsonSchema,
      toolConfig: buildTurnToolConfig(turnTools, options.toolChoice),
      messageCount: messages.length,
    });

    let isCacheHit = false;

    try {
      const replayedEntry = ctx.snapshot
        ? getJournalEntry(ctx, callId, { type: "prompt", contentHash: turnInputHash })
        : null;
      let message: Message;
      let finishReason: FinishReason;

      if (replayedEntry?.output !== undefined) {
        message = messageFromJournalOutput(replayedEntry.output);
        finishReason = message.tool_calls?.length ? "tool_calls" : "unknown";
        isCacheHit = true;
      } else {
        const llmResult: LLMCallResult = await callLLM(model, messages, {
          schema: options.jsonSchema,
          signal: ctx.signal,
          tools: turnTools.length > 0 ? turnTools : undefined,
          toolChoice: options.toolChoice,
          additionalOptions: options.additionalOptions,
          turnIndex: step,
          channel: options.channel,
        });

        message = messageFromLLMResult(llmResult);
        finishReason = llmResult.finishReason ?? "unknown";
      }

      // On replay this also replaces legacy plain-string output with the normalized Message
      // shape, so subsequent dumps stop persisting the legacy representation.
      recordJournal(ctx, callId, {
        type: "prompt",
        output: message,
        contentHash: turnInputHash,
      });

      // A replay bypasses callLLM, so reproduce the assembled-call events that live execution
      // already emitted before publishing the common per-turn boundary below.
      if (isCacheHit) {
        for (const toolCall of message.tool_calls ?? []) {
          emitStreamEvent(ctx, {
            type: "tool_call",
            turnIndex: step,
            channel: options.channel,
            toolCall,
          });
        }
      }

      emitStreamEvent(ctx, {
        type: "turn_done",
        turnIndex: step,
        channel: options.channel,
        finishReason,
      });

      const duration = isCacheHit ? 0 : elapsed();
      emitTurnEndSuccess(
        emitter,
        step,
        messages,
        options,
        turnTools,
        message,
        turnInputHash,
        isCacheHit,
        duration,
      );
      return { message, isCacheHit, contentHash: turnInputHash };
    } catch (error) {
      emitter?.turnEnd({
        step,
        messages,
        schema: options.jsonSchema,
        toolConfig: buildTurnToolConfig(turnTools, options.toolChoice),
        messageCount: messages.length,
        resultType: "content",
        duration: elapsed(),
        success: false,
        error: toErrorInfo(error as Error),
        contentHash: turnInputHash,
        cache: isCacheHit,
      });
      throw error;
    }
  });
}
