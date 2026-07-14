/**
 * Tool middlewares: observability + policy as composition, not framework config.
 *
 * Two middlewares demonstrate the two classic cross-cutting concerns of a
 * coding agent:
 *
 * - consoleToolLogger: print every tool invocation and a result preview.
 * - createApprovalGate: human confirmation before any mutating tool runs.
 *
 * Both are plain { name, handler(ctx, next) } objects attached per-tool via
 * `equipTool(tool, { middleware: [...] })`. Order matters: [logger, gate]
 * means the attempt is logged even when the gate then denies it.
 *
 * A denial deliberately RETURNS a string instead of throwing: the refusal
 * becomes a normal tool result the model can read, so it can propose an
 * alternative instead of crashing the run.
 */

import type { ToolMiddleware } from "@rejelly/core";
import prompts from "prompts";

/** Compact single-line preview for logging args and results. */
function preview(value: unknown, maxChars = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ");
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}

/** Log every tool call and a one-line preview of its result. */
export const consoleToolLogger: ToolMiddleware = {
  name: "console-tool-logger",
  handler: async (ctx, next) => {
    console.log(`\n🔧 ${ctx.toolName} ${preview(ctx.input)}`);
    const result = await next();
    console.log(`   ↳ ${preview(result)}`);
    return result;
  },
};

export interface ApprovalGateOptions {
  /** Skip the prompt and allow everything (for scripted/CI runs). */
  autoApprove?: boolean;
}

/**
 * Human-in-the-loop gate: ask y/N in the terminal before the tool executes.
 *
 * This is the whole "permission system" of this example — a dozen lines that
 * only the mutating tools are equipped with. Want a real policy (path
 * allowlists, command classification, audit log)? It goes here, and the tools
 * stay untouched.
 */
export function createApprovalGate(options?: ApprovalGateOptions): ToolMiddleware {
  const autoApprove = options?.autoApprove ?? false;
  return {
    name: "approval-gate",
    config: { autoApprove },
    handler: async (ctx, next) => {
      if (autoApprove) return next();
      const { approved } = await prompts({
        type: "confirm",
        name: "approved",
        message: `Allow ${ctx.toolName}? ${preview(ctx.input, 200)}`,
        initial: true,
      });
      // `approved` is undefined when the prompt is cancelled (Ctrl+C / no TTY);
      // treat anything but an explicit yes as a denial.
      if (approved !== true) {
        return `Denied by user: ${ctx.toolName} was not executed. Ask for guidance or try a different approach.`;
      }
      return next();
    },
  };
}
