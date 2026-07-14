/**
 * Trace Data Mapper
 *
 * Utility functions for data transformation and formatting
 * Used by trace repositories for data cleaning and serialization
 */

import { isAbortError, isBudgetExceededError } from "@rejelly/core";
import type { TraceEndReason } from "@rejelly/devtool-contracts";

// Constants for truncation limits
export const MAX_INPUT_PREVIEW_LENGTH = 100;
export const MAX_OUTPUT_PREVIEW_LENGTH = 200;
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Truncate JSON to preview string
 */
export function truncateInputPreview(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }

  try {
    const jsonStr = JSON.stringify(input);
    if (jsonStr.length <= MAX_INPUT_PREVIEW_LENGTH) {
      return jsonStr;
    }
    return `${jsonStr.substring(0, MAX_INPUT_PREVIEW_LENGTH - 3)}...`;
  } catch {
    return String(input).substring(0, MAX_INPUT_PREVIEW_LENGTH);
  }
}

/**
 * Truncate output to preview string
 * Used for storing result/response preview
 */
export function truncateOutputPreview(output: unknown): string | null {
  if (output === null || output === undefined) {
    return null;
  }

  try {
    const jsonStr = JSON.stringify(output);
    if (jsonStr.length <= MAX_OUTPUT_PREVIEW_LENGTH) {
      return jsonStr;
    }
    return `${jsonStr.substring(0, MAX_OUTPUT_PREVIEW_LENGTH - 3)}...`;
  } catch {
    return String(output).substring(0, MAX_OUTPUT_PREVIEW_LENGTH);
  }
}

/**
 * Truncate error message
 * Used for storing error details for debugging
 */
export function truncateErrorMessage(
  error: { message?: string } | string | null | undefined,
): string | null {
  if (!error) {
    return null;
  }

  let message: string;
  if (typeof error === "string") {
    message = error;
  } else if (error.message) {
    message = error.message;
  } else {
    return null;
  }

  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.substring(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

/**
 * Serialize full output to JSON string
 * Used for storing complete result data
 */
export function serializeOutputFull(output: unknown): string | null {
  if (output === null || output === undefined) {
    return null;
  }

  try {
    return JSON.stringify(output);
  } catch {
    // Fallback to string representation if JSON.stringify fails
    return String(output);
  }
}

/**
 * Derive the trace-level end reason from the root scope end.
 *
 * The failure signal is already carried on the end event's `error` (an ErrorInfo
 * whose `name` is preserved verbatim by core's `toErrorInfo`), so we classify by
 * the core error's stable `name` via the shared guards rather than re-deriving:
 *   - AbortError          -> "interrupted"   (user Ctrl+C / signal abort)
 *   - BudgetExceededError -> "budget_exceeded" (cost/token budget blown)
 *   - anything else       -> "error"
 *
 * The "interrupted" split matters mainly as a de-pollutant: without it every
 * intentional abort collapses into "failed"/"error", making a plain "show me
 * failed traces" query noisy. Turn/tool-loop limits are intentionally left as
 * generic "error": they are a different axis and have no dedicated end reason.
 */
export function deriveEndReason(
  success: boolean,
  error: { name?: string; message?: string } | null | undefined,
): TraceEndReason {
  if (success) {
    return "success";
  }
  if (isAbortError(error)) {
    return "interrupted";
  }
  if (isBudgetExceededError(error)) {
    return "budget_exceeded";
  }
  return "error";
}

/**
 * Serialize full error to JSON string
 * Used for storing complete error data
 * Handles ErrorInfo type which has name, message, and optional stack
 */
export function serializeErrorFull(
  error: { message?: string; stack?: string; name?: string } | null | undefined,
): string | null {
  if (!error) {
    return null;
  }

  try {
    // Serialize error object with all properties
    const errorObj: Record<string, unknown> = {};
    if (error.name) errorObj.name = error.name;
    if (error.message) errorObj.message = error.message;
    if (error.stack) errorObj.stack = error.stack;

    // If error has other enumerable properties, include them
    for (const key in error) {
      if (Object.hasOwn(error, key) && !["message", "stack", "name"].includes(key)) {
        try {
          errorObj[key] = (error as Record<string, unknown>)[key];
        } catch {
          // Skip non-serializable properties
        }
      }
    }

    return JSON.stringify(errorObj);
  } catch {
    // Fallback to string representation
    return String(error);
  }
}
