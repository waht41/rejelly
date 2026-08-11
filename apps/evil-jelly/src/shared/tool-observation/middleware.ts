/** Observe equipped tool calls and project their lifecycle to the configured runtime bindings. */

import type { ToolMiddleware } from "@rejelly/core";
import { getBinding } from "../host/hostBindings";
import {
  runWithToolDetailSlot,
  setActiveToolCall,
  takeActiveToolDetail,
} from "./invocationContext";
import { previewToolResult, projectToolStart, stringifyToolResult } from "./projection";

export function withToolLogger(): ToolMiddleware {
  return {
    name: "evil_jelly_tool_logger",
    handler: async (ctx, next) => {
      return runWithToolDetailSlot(async () => {
        const { printOut, logToolStart, logToolBlock } = getBinding();
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
          logToolBlock({
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
          logToolBlock({
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
