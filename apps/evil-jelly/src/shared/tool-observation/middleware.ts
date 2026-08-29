/** Observe equipped tool calls and project their lifecycle to the configured runtime bindings. */

import type { ToolContext, ToolMiddleware } from "@rejelly/core";
import { getBinding } from "../host/context";
import {
  runWithToolDetailSlot,
  setActiveToolCall,
  takeActiveToolDetail,
} from "./invocationContext";
import type { ToolObservationBlock } from "./model";
import { getToolObservationRecorder } from "./persistence";
import { previewToolResult, projectToolStart, stringifyToolResult } from "./projection";

async function emitCompletedTool(ctx: ToolContext, block: ToolObservationBlock): Promise<void> {
  const binding = getBinding();
  binding.logToolBlock(block);
  const toolCallId = ctx.metadata?.toolCallId;
  const recorder = getToolObservationRecorder();
  if (typeof toolCallId !== "string" || !recorder) return;
  try {
    await recorder.record(toolCallId, block);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    binding.logSystemEvent(`Session tool observation write failed: ${message}\n`);
  }
}

export function withToolLogger(): ToolMiddleware {
  return {
    name: "evil_jelly_tool_logger",
    handler: async (ctx, next) => {
      return runWithToolDetailSlot(async () => {
        const { printOut, logToolStart } = getBinding();
        const { summary, args } = projectToolStart(ctx);
        // The handle both numbers this call in invocation order and lets a streaming handler
        // attribute its output. Bindings without a live view get the one-line announcement.
        const call = logToolStart?.({ toolName: ctx.toolName, summary });
        if (call) {
          setActiveToolCall(call);
        } else {
          printOut(`${summary}\n`);
        }
        try {
          const result = await next();
          const fullResult = stringifyToolResult(result);
          await emitCompletedTool(ctx, {
            id: call?.id,
            ordinal: call?.ordinal,
            toolName: ctx.toolName,
            summary,
            args,
            detail: takeActiveToolDetail(),
            preview: previewToolResult(fullResult),
            fullResult,
            ok: true,
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emitCompletedTool(ctx, {
            id: call?.id,
            ordinal: call?.ordinal,
            toolName: ctx.toolName,
            summary,
            args,
            detail: takeActiveToolDetail(),
            preview: message.slice(0, 400),
            fullResult: message,
            ok: false,
          });
          throw error;
        }
      });
    },
  };
}

/** Shared instance for augmentTool (same middleware object across wrapped tools). */
export const evilJellyToolLoggerMiddleware = withToolLogger();
