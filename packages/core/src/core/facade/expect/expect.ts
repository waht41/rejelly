/**
 * Expect Series (Output Expectations)
 *
 * Functions for defining expected LLM output format and validation rules.
 * All expect* functions modify the current context's draft state.
 */

import type { z } from "zod";
import { getCurrentContext } from "../../context/accessor";
import { AfterPromptAgentError } from "../../domain/errors";

/**
 * Expect validator
 *
 * Defines custom validation logic for LLM output.
 *
 * Return values:
 * - `true`: Validation passed
 * - `string`: Validation failed, string is error message (triggers retry)
 *
 * Throw any error to abort immediately without retry.
 *
 * @example
 * // Overload 1: With schema for type inference
 * const UserSchema = z.object({ name: z.string(), age: z.number() });
 * expectValidator(UserSchema, (data) => {
 *   // data is inferred as { name: string; age: number }
 *   if (data.age < 0) return 'Age cannot be negative';
 *   return true;
 * });
 *
 * @example
 * // Overload 2: Without schema (manual type annotation)
 * expectValidator<{ price: number }>((data) => {
 *   // data is { price: number }
 *   if (data.price < 0) return 'Price cannot be negative';
 *   return true;
 * });
 *
 * @example
 * // Throw error for unrecoverable errors
 * expectValidator((data) => {
 *   if (data.type === 'fatal_error') {
 *     throw new Error('LLM returned fatal error, cannot continue');
 *   }
 *   if (data.price < 0) return 'Price cannot be negative';
 *   return true;
 * });
 *
 */

// Overload 1: With schema, auto-infer type T
export function expectValidator<T>(
  schema: z.Schema<T>,
  validator: (data: T) => boolean | string | Promise<boolean | string>,
): void;

// Overload 2: Without schema, manual type annotation
export function expectValidator<T = unknown>(
  validator: (data: T) => boolean | string | Promise<boolean | string>,
): void;

// Implementation
export function expectValidator(
  arg1: z.ZodTypeAny | ((data: unknown) => boolean | string | Promise<boolean | string>),
  arg2?: (data: unknown) => boolean | string | Promise<boolean | string>,
): void {
  const ctx = getCurrentContext();
  if (ctx.draft.prompted) {
    throw new AfterPromptAgentError("expectValidator");
  }

  // Runtime check: determine if arg1 is a Zod Schema (duck typing)
  // Zod objects typically contain _def, parse, safeParse properties
  const isSchema = (arg: unknown): arg is z.ZodTypeAny => {
    return (
      typeof arg === "object" &&
      arg !== null &&
      // _def is Zod's internal definition property, most accurate for detection
      "_def" in arg
    );
  };

  if (isSchema(arg1)) {
    // Overload 1: schema, validator
    // Schema is only used for type inference, not stored
    const validator = arg2 as (data: unknown) => boolean | string | Promise<boolean | string>;
    ctx.draft.validators.push({ validator });
  } else {
    // Overload 2: validator
    const validator = arg1;
    ctx.draft.validators.push({ validator });
  }
}
