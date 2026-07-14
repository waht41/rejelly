/**
 * Append turn-budget hints to the last tool output of each batch so the model
 * sees remaining tool-capable rounds before hitting maxTurnSteps.
 */

import { equipToolCallLoopMiddleware, type ToolCallLoopMiddleware } from "@rejelly/core";
import { appendMessageContentSuffix } from "../../shared/lib/message";

/** Same default as createAgent context factory; keep in sync with agent maxTurnSteps for hints. */
export const DEFAULT_TOOL_LOOP_MAX_TURN_STEPS = 10;
/** Start warning only when entering this many final rounds. */
export const TOOL_LOOP_WARNING_WINDOW = 5;

/**
 * Build the English hint string for remaining LLM turns after the current tool batch.
 * ctxStep is 0-based (same as ToolCallLoopContext.step).
 */
export function buildToolLoopBudgetSuffix(maxTurnSteps: number, ctxStep: number): string {
  const remainingTurns = maxTurnSteps - ctxStep - 1;
  let budgetTail: string;
  if (remainingTurns === 0) {
    budgetTail =
      "No tool-invoking turns remain after this batch: the budget is exhausted. " +
      "DO NOT call any tool. " +
      "Output your final answer now from what you already have. " +
      "If you still try another tool round, ToolLoopExceededError will end this run.";
  } else if (remainingTurns === 1) {
    budgetTail =
      "CRITICAL: this is your last tool-capable round. " +
      "YOU ARE NOW FORBIDDEN FROM CALLING ANY TOOLS. " +
      "Output your final answer instead. Any attempt to call a tool now will result in a fatal crash.";
  } else if (remainingTurns === 2) {
    budgetTail =
      "Warning: only 2 tool-capable rounds remain. " +
      "Stop gathering context and prepare to output your final answer from what you already have.";
  } else {
    budgetTail =
      `After this batch you have ${remainingTurns} more rounds before hitting the cap. ` +
      "Going past the limit throws ToolLoopExceededError and ends the run with no additional tools.";
  }
  return `[tool-loop-budget] Each run allows at most ${maxTurnSteps} model turns. ${budgetTail}`;
}

export function createToolLoopBudgetMiddleware(options: {
  maxTurnSteps: number;
  name: string;
}): ToolCallLoopMiddleware {
  const { maxTurnSteps, name } = options;
  return {
    name,
    handler: async (ctx, calls, next) => {
      const remainingTurns = maxTurnSteps - ctx.step - 1;
      const outputs = await next(calls);
      if (outputs.length === 0) {
        return outputs;
      }
      if (remainingTurns > TOOL_LOOP_WARNING_WINDOW) {
        return outputs;
      }
      if (remainingTurns === 1 && calls.length > 0) {
        const budgetTail =
          "SYSTEM OVERRIDE: 0 TOOL TURNS REMAIN. " +
          "YOU ARE NOW FORBIDDEN FROM CALLING ANY TOOLS. " +
          "Output your final answer instead. " +
          "Any attempt to call a tool now will result in a fatal crash.";
        const forcedMessage = `[tool-loop-budget] Each run allows at most ${maxTurnSteps} model turns. ${budgetTail}`;
        const lastIndex = outputs.length - 1;
        return outputs.map((out, i) =>
          i === lastIndex ? { ...out, content: forcedMessage } : out,
        );
      }
      const hint = buildToolLoopBudgetSuffix(maxTurnSteps, ctx.step);
      const lastIndex = outputs.length - 1;
      return outputs.map((out, i) =>
        i === lastIndex ? { ...out, content: appendMessageContentSuffix(out.content, hint) } : out,
      );
    },
  };
}

/** Registers middleware that appends the standard tool-loop turn budget hint to the last tool result. */
export function equipToolLoopBudgetMiddleware(options: {
  maxTurnSteps: number;
  name: string;
}): void {
  equipToolCallLoopMiddleware(createToolLoopBudgetMiddleware(options));
}
