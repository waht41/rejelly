/**
 * Unified error handling for the Gemini adapter.
 */

import type { ModelErrorCode } from "@rejelly/core";
import { AbortError, isAbortError, ModelCallError } from "@rejelly/core";

export function classifyGeminiError(error: unknown): ModelErrorCode {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: number }).status;
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth_error";
    if (status === 500 || status === 502 || status === 503) return "server_error";
  }
  if (error instanceof Error && /quota|resource.exhausted/i.test(error.message)) {
    return "rate_limit";
  }
  return "unknown";
}

function isGeminiAbortLikeError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (error === null || typeof error !== "object") {
    return false;
  }
  const rec = error as Record<string, unknown>;
  return rec.message === "Request was aborted." || rec.message === "AbortError";
}

export function wrapAsModelCallError(error: unknown, modelId: string): never {
  if (isGeminiAbortLikeError(error)) {
    throw new AbortError(error instanceof Error ? error.message : undefined);
  }
  throw new ModelCallError(error instanceof Error ? error.message : String(error), {
    modelId,
    provider: "gemini",
    code: classifyGeminiError(error),
    originalError: error,
  });
}
