/**
 * Validation and Parsing Types
 *
 * Types related to structured output validation logic.
 */

import type { z } from "zod";

/**
 * Internal storage for expectValidator entries
 */
export interface ExpectValidatorEntry {
  validator: (data: unknown) => boolean | string | Promise<boolean | string>;
}

/**
 * Failure produced by executeValidation: parsing (`no_content` / `parse_error` / `schema`)
 * or the expectValidator contract (`validator`). This is the exact result space of
 * `executeValidation` — it never reports LLM call errors.
 */
export type ValidationFailure =
  | { type: "no_content" | "parse_error" }
  | { type: "schema"; issues: z.ZodIssue[] }
  | { type: "validator" };

/**
 * Internal attempt-failure vocabulary for the preset tool-call loop: everything
 * executeValidation can produce, plus `llm_error` for failed model calls.
 * Deliberately not exported — each policy owns its own failure vocabulary and can
 * extend ValidationFailure as it sees fit (AttemptsExhaustedError.lastFailureType
 * is a plain string, so custom vocabularies cross that boundary freely).
 */
export type FailureInfo = ValidationFailure | { type: "llm_error" };

export type ValidationAttemptResult =
  | { success: true; data: unknown; errors: string[] } // Success: always has data, errors is []
  | { success: false; data: unknown; failure: ValidationFailure; errors: string[] }; // Failure: may have partial data, always has failure reason and errors
