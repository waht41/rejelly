/**
 * Retries tool handler when the inner chain throws (e.g. transient FS errors).
 */

import type { ToolMiddleware } from "@rejelly/core";

export function withToolRetry(maxAttempts: number): ToolMiddleware {
  if (maxAttempts < 1) {
    throw new Error("withToolRetry: maxAttempts must be >= 1");
  }
  return {
    name: "evil_jelly_tool_retry",
    config: { maxAttempts },
    handler: async (_ctx, next) => {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await next();
        } catch (e) {
          if (i === maxAttempts - 1) {
            throw e;
          }
        }
      }
      throw new Error("withToolRetry: exhausted attempts without result");
    },
  };
}
