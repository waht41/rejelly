/**
 * Validation Engine
 *
 * Functions for running parser output through framework validators.
 */

import { getCurrentContext } from "../context/accessor";
import type { AgentContext } from "../context/type";
import type { ExpectValidatorEntry, ValidationAttemptResult } from "../context/validation";
import type { JsonSchema } from "../domain/model";
import { withSpan } from "../observability/trace";
import type { OutputParser } from "./parse";
import { assertRuntimeUsable, type PromptRuntime } from "./runtime";

export { cleanLLMResponse } from "./parse";

/**
 * Lightweight partial-schema funnel for streaming chunks: rejects JSON whose top-level keys
 * are not a subset of the target object schema's `properties` (cuts false positives when the
 * model embeds unrelated JSON, e.g. tool examples in prose). Not a full JSON Schema validator.
 *
 * - Skips key filtering when the schema root is not a plain `object` with `properties`, or when
 *   `additionalProperties` allows extra keys (`true` or an object schema).
 * - `anyOf` / `oneOf`: passes if any branch passes; `allOf`: every branch must pass.
 */
export function validatePartialSchema(data: unknown, schema: JsonSchema): boolean {
  if (data === null || typeof data !== "object") {
    return false;
  }

  if (Array.isArray(data)) {
    if (schema.type === "array" || schema.items !== undefined) {
      return true;
    }
    if (
      schema.type === "object" &&
      schema.properties &&
      Object.keys(schema.properties).length > 0
    ) {
      return false;
    }
    return true;
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf) && allOf.length > 0) {
    return allOf.every((branch: JsonSchema) => validatePartialSchema(data, branch));
  }

  const oneOf = schema.oneOf as JsonSchema[] | undefined;
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    return oneOf.some((branch: JsonSchema) => validatePartialSchema(data, branch));
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    return anyOf.some((branch: JsonSchema) => validatePartialSchema(data, branch));
  }

  if (schema.type !== "object" || !schema.properties) {
    return true;
  }

  const schemaKeys = Object.keys(schema.properties);
  if (schemaKeys.length === 0) {
    return true;
  }

  const allowUnknownKeys =
    schema.additionalProperties === true ||
    (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null);

  if (allowUnknownKeys) {
    return true;
  }

  const dataKeys = Object.keys(data as Record<string, unknown>);
  if (dataKeys.length === 0) {
    return true;
  }

  const hasInvalidKey = dataKeys.some((key) => !schemaKeys.includes(key));
  return !hasInvalidKey;
}

/**
 * Run all validators against data
 *
 * @param data - Data to validate
 * @param validators - Validator entries
 * @returns Validator result
 */
export async function runValidators(
  data: unknown,
  validators: ExpectValidatorEntry[],
): Promise<{ success: boolean; data: unknown; errors: string[] }> {
  const errors: string[] = [];

  for (const entry of validators) {
    const result = await entry.validator(data);

    if (result === true) {
      continue; // Passed
    }

    if (typeof result === "string") {
      errors.push(result);
    } else if (result === false) {
      // Treat false as validation failure with default message
      errors.push("Validation failed");
    }
  }

  return {
    success: errors.length === 0,
    data,
    errors,
  };
}

/**
 * Execute validation for LLM response (internal implementation)
 *
 * Execution order:
 * 1. Parse via the provided OutputParser
 * 2. Validator validation (if validators exist)
 *
 * @param ctx - Agent context
 * @param rawText - Raw LLM response text
 * @param parser - custom parser before validator runs
 * @returns Validation result with success/failure status and errors from this attempt
 */
export async function _executeValidation(
  ctx: AgentContext,
  rawText: string,
  parser: OutputParser,
): Promise<ValidationAttemptResult> {
  const parserResult = parser.parse(rawText);
  if (!parserResult.success) {
    return {
      success: false,
      data: null,
      failure:
        parserResult.failureType === "schema"
          ? { type: "schema", issues: parserResult.issues ?? [] }
          : { type: parserResult.failureType },
      errors: parserResult.errors,
    };
  }
  return validateData(ctx, parserResult.data);
}

async function validateData(ctx: AgentContext, data: unknown): Promise<ValidationAttemptResult> {
  if (ctx.draft.validators.length > 0) {
    const result = await runValidators(data, ctx.draft.validators);
    if (!result.success) {
      return {
        success: false,
        data,
        failure: { type: "validator" },
        errors: result.errors,
      };
    }
  }

  return { success: true, data, errors: [] };
}

/**
 * Execute validation for LLM response with event emission
 *
 * Wrapper that handles:
 * - Scope creation for trace hierarchy
 * - validation:fail/success events
 *
 * @param rawText - Raw LLM response text
 * @param options - Runtime (required), optional parser and retry metadata
 * @returns Validation result with success/failure status and errors from this attempt
 */
export async function executeValidation(
  rawText: string,
  options: {
    /**
     * Capability proof that this call happens inside a policy execution — the
     * same gate as `executeTurn` / `executeTools`. executeValidation reads
     * validators from the ambient draft, not from the runtime; requiring the
     * runtime here binds the call to the active policy so the `validationRan`
     * bookkeeping (which backs the "validators never ran" warning at the policy
     * barrier) cannot be flipped from an agent handler.
     */
    runtime: PromptRuntime;
    parser?: OutputParser;
    attempt?: number;
  },
): Promise<ValidationAttemptResult> {
  // Gate before opening the validation span: a rejected call must not emit
  // validation telemetry or touch the validationRan flag.
  assertRuntimeUsable(options?.runtime, getCurrentContext(), "executeValidation");
  return withSpan("validation", async (emitter) => {
    const scopedCtx = getCurrentContext();
    scopedCtx.draft.validationRan = true;
    const { parser, attempt } = options;

    if (!parser) {
      const passthroughResult = await validateData(scopedCtx, rawText);
      if (!passthroughResult.success) {
        emitter?.validationFail({
          rawText,
          parserId: "rawText",
          attempt,
          data: passthroughResult.data,
          success: false,
          errors: passthroughResult.errors.map((msg) => ({
            name: "ValidationError",
            message: msg,
          })),
        });
        return passthroughResult;
      }
      emitter?.validationSuccess({
        rawText,
        parserId: "rawText",
        attempt,
        data: passthroughResult.data,
        success: true,
      });
      return passthroughResult;
    }

    // Call internal validation logic
    const validationResult = await _executeValidation(scopedCtx, rawText, parser);

    if (!validationResult.success) {
      emitter?.validationFail({
        rawText,
        parserId: parser.id,
        attempt,
        data: validationResult.data,
        success: false,
        errors: validationResult.errors.map((msg) => ({ name: "ValidationError", message: msg })),
      });
    } else {
      emitter?.validationSuccess({
        rawText,
        parserId: parser.id,
        attempt,
        data: validationResult.data,
        success: true,
      });
    }

    return validationResult;
  });
}
