/**
 * Prompt Agent
 *
 * Core function for LLM interaction with tool loop support.
 */

import { startTimer } from "../../utils/clock";
import { getCurrentContext } from "../context/accessor";
import type { ToolCallLoopMiddleware } from "../context/tool-call-loop";
import { ModelNotFoundError, PromptAgentAlreadyCalledError, toErrorInfo } from "../domain/errors";
import {
  type Message,
  type MessageContent,
  REJELLY_INSTRUCTION_MESSAGE_KIND,
} from "../domain/model";
import type { ToolDefinition } from "../domain/tool";
import { findModelInContextChain } from "../engine/chain";
import { ensureGenerationStreamRuntime } from "../engine/effect";
import { normalizeMessages } from "../engine/message-builder";
import { type PromptRuntime, type RuntimeSeal, sealRuntime } from "../engine/runtime";
import { type Span, withSpan } from "../observability/trace";
import { logger } from "../shared/logger/instance";

type ForkValue<T> = T | ((base: T) => T);

export interface PromptContextForkOptions {
  messages?: ForkValue<Message[]>;
  system?: ForkValue<Message[]>;
  instruction?: ForkValue<Message[]>;
  tools?: ForkValue<ToolDefinition[]>;
  toolCallLoopMiddlewares?: ForkValue<ToolCallLoopMiddleware[]>;
}

export interface PromptContext extends PromptRuntime {
  maxRetries: number;
  maxTurnSteps: number;
  /**
   * Model turns already consumed in this generation (live value; validation
   * retries also count). Compare against `maxTurnSteps` to budget remaining
   * turns before `executeTurn` throws TurnBudgetExceededError — useful for
   * policies that fan out (e.g. graph/ToT) and want to degrade gracefully.
   */
  readonly usedTurnSteps: number;
  /**
   * Span handle to write extra metadata during policy execution.
   * Attributes accumulated here land on the prompt span's `trace.attributes`
   * (the canonical span-attribute bag) and surface on the prompt:end snapshot.
   */
  span: Span;
  /**
   * Derive a node/turn-local runtime view without mutating the generation draft.
   * Budget, tracing, validation bookkeeping, and snapshot journal remain owned by
   * the same underlying AgentContext.
   */
  fork(options?: PromptContextForkOptions): PromptContext;
}

/**
 * Create a span handle that writes attributes onto the given span's `trace.attributes`
 * (the canonical span-attribute bag, same as withCustomSpan / equipTraceAttr). Replacing
 * the object on each write keeps already-emitted event snapshots (deep-cloned at emit time)
 * intact, so what the policy accumulates surfaces on the prompt:end snapshot.
 */
function createTraceAttrSpan(trace: { attributes?: Record<string, unknown> } | undefined): Span {
  return {
    setAttribute(key, value) {
      if (trace) trace.attributes = { ...(trace.attributes ?? {}), [key]: value };
    },
    setAttributes(attributes) {
      if (trace) trace.attributes = { ...(trace.attributes ?? {}), ...attributes };
    },
  };
}

function buildSystemMessages(systemPrompts: string[]): Message[] {
  return systemPrompts.map((content) => ({
    role: "system",
    content,
  }));
}

function buildInstructionMessages(instructions: MessageContent[]): Message[] {
  return instructions.map((content) => ({
    role: "user",
    content,
    extra: { rejelly: { kind: REJELLY_INSTRUCTION_MESSAGE_KIND } },
  }));
}

function resolveForkValue<T>(base: T, value: ForkValue<T> | undefined): T {
  if (value === undefined) return base;
  return typeof value === "function" ? (value as (base: T) => T)(base) : value;
}

function createPromptContext(params: {
  messages: Message[];
  system: Message[];
  instruction: Message[];
  tools: ToolDefinition[];
  toolCallLoopMiddlewares: ToolCallLoopMiddleware[];
  maxRetries: number;
  maxTurnSteps: number;
  usedTurnSteps: () => number;
  span: Span;
  seal: RuntimeSeal;
}): PromptContext {
  const promptContext: PromptContext = {
    messages: [...params.messages],
    system: [...params.system],
    instruction: [...params.instruction],
    tools: [...params.tools],
    toolCallLoopMiddlewares: [...params.toolCallLoopMiddlewares],
    maxRetries: params.maxRetries,
    maxTurnSteps: params.maxTurnSteps,
    get usedTurnSteps() {
      return params.usedTurnSteps();
    },
    span: params.span,
    fork(options: PromptContextForkOptions = {}) {
      return createPromptContext({
        messages: [...resolveForkValue(this.messages, options.messages)],
        system: [...resolveForkValue(this.system, options.system)],
        instruction: [...resolveForkValue(this.instruction, options.instruction)],
        tools: [...resolveForkValue(this.tools, options.tools)],
        toolCallLoopMiddlewares: [
          ...resolveForkValue(this.toolCallLoopMiddlewares, options.toolCallLoopMiddlewares),
        ],
        maxRetries: this.maxRetries,
        maxTurnSteps: this.maxTurnSteps,
        usedTurnSteps: params.usedTurnSteps,
        span: this.span,
        // Same seal reference: forks live and die with their policy execution.
        seal: params.seal,
      });
    },
  };
  sealRuntime(promptContext, params.seal);

  return promptContext;
}

export interface AgentPolicy<TArgs extends unknown[], TResult> {
  policyId: string;
  handler: (ctx: PromptContext, ...args: TArgs) => Promise<TResult>;
}

export function createAgentPolicy<TArgs extends unknown[], TResult>(
  policy: AgentPolicy<TArgs, TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const ctx = getCurrentContext();

    if (ctx.draft.prompted) {
      throw new PromptAgentAlreadyCalledError();
    }
    ctx.draft.prompted = true;
    ensureGenerationStreamRuntime(ctx);
    return await withSpan(`prompt:${policy.policyId}`, async (emitter) => {
      const scopedCtx = getCurrentContext();
      const model = findModelInContextChain(scopedCtx);
      if (!model) {
        throw new ModelNotFoundError();
      }
      const span = createTraceAttrSpan(scopedCtx.trace);
      const system = buildSystemMessages(scopedCtx.draft.systemPrompts);
      const instruction = buildInstructionMessages(scopedCtx.draft.instructions);
      // One seal per policy invocation, shared by reference across all forks of
      // this base PromptContext; flipped dead in the finally below so no runtime
      // outlives this policy execution.
      const seal: RuntimeSeal = { alive: true, owner: scopedCtx };
      const promptContext = createPromptContext({
        messages: normalizeMessages([...system, ...instruction]),
        system,
        instruction,
        tools: scopedCtx.draft.tools,
        toolCallLoopMiddlewares: scopedCtx.draft.toolCallLoopMiddlewares,
        maxRetries: scopedCtx.maxRetries,
        maxTurnSteps: scopedCtx.maxTurnSteps,
        usedTurnSteps: () => scopedCtx.draft.steps,
        span,
        seal,
      });
      const elapsed = startTimer();
      const generationId = scopedCtx.generationId ?? 0;

      emitter?.promptAgentStart({
        generationId,
        policyId: policy.policyId,
      });

      try {
        const result = await policy.handler(promptContext, ...args);

        if (scopedCtx.draft.validators.length > 0 && !scopedCtx.draft.validationRan) {
          logger.warn(
            `expectValidator() was registered, but policy "${policy.policyId}" never called executeValidation(), so the validators did not run. ` +
              `Custom policies must run final content through executeValidation() to honor the expectValidator contract.`,
          );
        }

        emitter?.promptAgentEnd({
          generationId,
          policyId: policy.policyId,
          result,
          totalSteps: scopedCtx.draft.steps,
          duration: elapsed(),
          success: true,
        });

        return result;
      } catch (error) {
        emitter?.promptAgentEnd({
          generationId,
          policyId: policy.policyId,
          totalSteps: scopedCtx.draft.steps,
          duration: elapsed(),
          success: false,
          error: toErrorInfo(error as Error),
        });
        throw error;
      } finally {
        seal.alive = false;
      }
    });
  };
}
