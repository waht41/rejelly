/**
 * Stateless context-occupancy governor at the tool-call-loop layer.
 *
 * Instead of accumulating a running tally of tool-output tokens in a closure, this reads REAL live
 * context occupancy from `ctx.messages` (the loop conversation the model is about to see) on every
 * batch. Because it measures ground truth rather than a monotonic sum, it needs no reset: after a
 * reborn or any history trim/compaction the occupancy simply reflects the smaller conversation.
 *
 * It sits at the single chokepoint where a whole turn's tool calls are about to execute, so one
 * declared name set governs a group of tools (read_file + grep + symbol reads) and an unbudgeted
 * tool can't quietly bypass the cap.
 *
 * Degradation is soft:
 * - below warn threshold: outputs pass through untouched
 * - in the warn band: outputs pass through, with a nudge appended to the last budgeted output
 * - at/over the cap: budgeted calls in this and later turns are refused WITHOUT executing (forged
 *   refusals), saving the underlying IO; non-budgeted calls still run
 *
 * Use this where a hard per-run intake/context ceiling is wanted and there is NO auto-compaction to
 * recover space (e.g. the audit per-seed fan-out). The interactive coding loop instead uses the
 * policy-level occupancy governor, which compacts rather than refuses.
 */

import {
  equipToolCallLoopMiddleware,
  type ToolCall,
  type ToolCallLoopContext,
  type ToolCallLoopMiddleware,
  type ToolOutput,
} from "@rejelly/core";
import { estimateMessagesTokens } from "../../../shared/lib/tokens";
import { appendMessageContentSuffix } from "../../../shared/model/message/content";

const DEFAULT_WARN_RATIO = 0.8;

export interface ContextIntakeBudgetOptions {
  /** Middleware name (for debugging / dashboard). */
  name: string;
  /** Context-occupancy token ceiling; at/over it, budgeted tools are refused. */
  maxTokens: number;
  /** Tool names refused once occupancy reaches the ceiling. */
  budgetedTools: Iterable<string>;
  /** Fraction (0, 1] of the ceiling at which to start nudging the model to narrow. Default 0.8. */
  warnRatio?: number;
}

function narrowHint(occupancy: number, max: number): string {
  return (
    `[context budget warning: ~${occupancy}/${max} tokens of context in use. ` +
    "Prefer grep / ast_document_symbols / ast_read_symbol over full reads to narrow further.]"
  );
}

function refusalContent(max: number): string {
  return (
    `context budget reached: ~${max} tokens of context already in use.\n` +
    "No further reads/searches will be provided — produce your final answer now from the evidence already collected."
  );
}

export function createContextIntakeBudgetMiddleware(
  options: ContextIntakeBudgetOptions,
): ToolCallLoopMiddleware {
  const { name, maxTokens } = options;
  const warnRatio = options.warnRatio ?? DEFAULT_WARN_RATIO;
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    throw new Error("createContextIntakeBudgetMiddleware: maxTokens must be a finite number >= 1");
  }
  if (!(warnRatio > 0 && warnRatio <= 1)) {
    throw new Error("createContextIntakeBudgetMiddleware: warnRatio must be in (0, 1]");
  }
  const budgeted = new Set(options.budgetedTools);
  const warnAtTokens = Math.floor(maxTokens * warnRatio);

  const isBudgeted = (call: ToolCall) => budgeted.has(call.name);
  const occupancyOf = (ctx: ToolCallLoopContext) => estimateMessagesTokens(ctx.messages);

  return {
    name,
    config: { maxTokens, warnRatio, budgetedTools: [...budgeted] },
    handler: async (ctx, calls, next) => {
      // Ground-truth occupancy of the conversation about to be sent to the model (before this
      // batch's outputs, which don't exist yet). Overshoot is naturally bounded to one batch: the
      // batch that crosses runs, and the next one sees occupancy over the cap and is refused.
      const occupancy = occupancyOf(ctx);

      // At/over the ceiling: refuse budgeted calls without executing; run the rest. Every received
      // call still gets exactly one output (forged or real).
      if (occupancy >= maxTokens) {
        const passthrough = calls.filter((c) => !isBudgeted(c));
        const realOutputs = passthrough.length > 0 ? await next(passthrough) : [];
        const forged: ToolOutput[] = calls
          .filter(isBudgeted)
          .map((c) => ({ callId: c.id, content: refusalContent(maxTokens) }));
        return [...realOutputs, ...forged];
      }

      const outputs = await next(calls);

      // Below the warn band: untouched.
      if (occupancy < warnAtTokens) {
        return outputs;
      }

      // Warn band: annotate only the last budgeted output with a narrow nudge.
      const budgetedCallIds = new Set(calls.filter(isBudgeted).map((c) => c.id));
      let lastBudgetedIndex = -1;
      for (let i = 0; i < outputs.length; i += 1) {
        if (budgetedCallIds.has(outputs[i].callId)) {
          lastBudgetedIndex = i;
        }
      }
      if (lastBudgetedIndex === -1) {
        return outputs;
      }
      const hint = narrowHint(occupancy, maxTokens);
      return outputs.map((out, i) =>
        i === lastBudgetedIndex
          ? { ...out, content: appendMessageContentSuffix(out.content, hint) }
          : out,
      );
    },
  };
}

/** Registers a stateless context-occupancy budget over the given tools at the tool-call-loop layer. */
export function equipContextIntakeBudgetMiddleware(options: ContextIntakeBudgetOptions): void {
  equipToolCallLoopMiddleware(createContextIntakeBudgetMiddleware(options));
}
