import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { FailureInfo } from "../context/validation";
import {
  AttemptsExhaustedError,
  isAbortError,
  SchemaConversionError,
  ToolLoopExceededError,
} from "../domain/errors";
import type { JsonSchema, Message, ToolCall } from "../domain/model";
import type { OutputParser } from "../engine/parse";
import { executeTools } from "../engine/tool-executor";
import { executeTurn } from "../engine/turn";
import { executeValidation } from "../engine/validation";
import type { PromptContext } from "./prompt";

export function transferJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  try {
    return zodToJsonSchema(schema, { $refStrategy: "none" }) as JsonSchema;
  } catch (err) {
    throw new SchemaConversionError("Failed to convert Zod schema to JSON Schema.", err);
  }
}

export interface ToolCallLoopPolicySnapshot {
  jsonSchema?: JsonSchema;
  parser?: OutputParser;
}

export interface ToolCallLoopPolicyResult<T = unknown> {
  data: T;
  delta: Message[];
}

/**
 * One turn step of a tool-call loop: either the model asked for tools (handed
 * back for the caller's loop to execute), or it produced final content that is
 * validated in-place, retrying up to `maxRetries` within this same step.
 */
export type LoopTurnResult =
  | { kind: "content"; data: unknown; deltaMessages: Message[] }
  | { kind: "tool_calls"; calls: ToolCall[]; deltaMessages: Message[] };

export interface ExecuteValidatedLoopTurnParams {
  runtime: PromptContext;
  jsonSchema?: JsonSchema;
  parser?: OutputParser;
  maxRetries: number;
}

/**
 * Convenience sugar over `executeTurn` + `executeValidation`, NOT a fourth
 * primitive. It bundles the validation-retry bookkeeping (attempt counting,
 * delta message shaping, `AttemptsExhaustedError`) that tool-call-loop policies
 * otherwise re-copy. Its `LoopTurnResult` shape is deliberately loop-flavored:
 * a policy wanting different delta shaping or retry semantics should drop to the
 * raw primitives instead, the same way custom caching drops to `equipMemory`
 * rather than `equipMemo`.
 */
export async function executeValidatedLoopTurn(
  params: ExecuteValidatedLoopTurnParams,
): Promise<LoopTurnResult> {
  const { runtime, jsonSchema, parser, maxRetries } = params;
  const allErrors: string[] = [];
  let lastFailure: FailureInfo | null = null;
  let lastData: unknown = null;
  let lastRawText = "";
  // Single source of truth for this turn's new messages. The full conversation
  // fed to the model is derived as [...runtime.messages, ...deltaMessages].
  const deltaMessages: Message[] = [];

  for (let attemptNumber = 0; attemptNumber <= maxRetries; attemptNumber++) {
    try {
      const { message } = await executeTurn([...runtime.messages, ...deltaMessages], {
        runtime,
        jsonSchema,
      });

      const toolCalls = message.tool_calls;
      if (toolCalls !== undefined && toolCalls.length > 0) {
        return {
          kind: "tool_calls",
          calls: toolCalls,
          // Carry any within-step retry history (failed content + feedback) so
          // it is not lost when a validation retry pivots to tool calls.
          deltaMessages: [...deltaMessages, message],
        };
      }

      lastRawText = typeof message.content === "string" ? message.content : "";
      const validationResult = await executeValidation(lastRawText, {
        runtime,
        parser,
        attempt: attemptNumber,
      });

      if (validationResult.success) {
        return {
          kind: "content",
          data: validationResult.data,
          deltaMessages: [
            ...deltaMessages,
            {
              ...message,
              content: parser ? lastRawText || null : (validationResult.data as string) || null,
            },
          ],
        };
      }

      allErrors.push(...validationResult.errors);
      lastData = validationResult.data ?? lastData;
      lastFailure = validationResult.failure;
      const validationFeedbackMessage: Message = {
        role: "user",
        content: `Output validation failed:\n${validationResult.errors.join("\n")}\nPlease fix the errors above.`,
      };
      deltaMessages.push(
        {
          ...message,
          content: lastRawText || null,
        },
        validationFeedbackMessage,
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const err = error as Error;
      allErrors.push(`LLM call failed: ${err.message}`);
      lastFailure = { type: "llm_error" };
      throw error;
    }
  }

  throw new AttemptsExhaustedError({
    attempts: maxRetries + 1,
    issues: allErrors,
    lastFailureType: lastFailure?.type ?? null,
    lastData,
    lastRawText,
  });
}

export async function runToolCallLoopPolicy<T = unknown>(
  ctx: PromptContext,
  snapshot: ToolCallLoopPolicySnapshot,
): Promise<ToolCallLoopPolicyResult<T>> {
  const maxTurnSteps = ctx.maxTurnSteps;
  // The preset deliberately sets neither toolChoice nor stream options: per-turn
  // toolChoice belongs to executeTurn (write a custom policy), and generation
  // params (temperature, …) belong to the model adapter.
  // Single source of truth: deltaMessages holds this run's new messages, and the
  // working conversation is derived as [...ctx.messages, ...deltaMessages].
  const deltaMessages: Message[] = [];

  let step = 0;

  while (step < maxTurnSteps) {
    const result = await executeValidatedLoopTurn({
      runtime: ctx.fork({ messages: [...ctx.messages, ...deltaMessages] }),
      jsonSchema: snapshot.jsonSchema,
      parser: snapshot.parser,
      maxRetries: ctx.maxRetries,
    });

    deltaMessages.push(...result.deltaMessages);

    if (result.kind === "content") {
      return { data: result.data as T, delta: deltaMessages };
    }

    if (step >= maxTurnSteps - 1) {
      step++;
      break;
    }

    const toolRuntime = ctx.fork({ messages: [...ctx.messages, ...deltaMessages] });
    const toolOutputs = await executeTools(result.calls, { runtime: toolRuntime });
    deltaMessages.push(...toolOutputs);
    step++;
  }

  throw new ToolLoopExceededError(maxTurnSteps, maxTurnSteps);
}
