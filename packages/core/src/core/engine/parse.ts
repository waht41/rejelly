/**
 * Output Parsing
 *
 * Parser abstractions for converting raw LLM text into structured data.
 */

import type { z } from "zod";

export type ParseResult<T = unknown> =
  | { success: true; data: T }
  | {
      success: false;
      errors: string[];
      failureType: "parse_error" | "no_content" | "schema";
      issues?: z.ZodIssue[];
    };

export interface OutputParser<T = unknown> {
  /** Parser identifier used for logs / tracing. */
  id: string;
  /**
   * Parse raw LLM output into target data.
   * @param rawText - Raw text returned by the model
   */
  parse(rawText: string): ParseResult<T>;
}

/**
 * From s[start] (must be `{` or `[`), return inclusive end index of the matching top-level JSON value, or null if unclosed / malformed nesting.
 * Ignores `{` `}` `[` `]` inside double-quoted strings; handles `\"` and `\\` inside strings.
 */
function endIndexOfBalancedJson(s: string, start: number): number | null {
  const open = s[start];
  if (open !== "{" && open !== "[") return null;

  const stack: ("{" | "[")[] = [open];
  let inString = false;
  let stringEscape = false;

  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (stringEscape) {
      stringEscape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") stringEscape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }

    const top = stack[stack.length - 1];
    if (ch === "{") {
      stack.push("{");
    } else if (ch === "[") {
      stack.push("[");
    } else if (ch === "}") {
      if (top !== "{") return null;
      stack.pop();
      if (stack.length === 0) return i;
    } else if (ch === "]") {
      if (top !== "[") return null;
      stack.pop();
      if (stack.length === 0) return i;
    }
  }

  return null;
}

/**
 * Clean LLM response text for JSON parsing
 *
 * - Starts from the first fenced ``` / ```json block when its content looks like JSON.
 * - Otherwise finds the first `{` or `[`.
 * - Slices to the end of the first balanced JSON value.
 * - If the value is still unclosed, keeps from first brace to end.
 * - Strips a trailing ``` fence when present.
 */
export function cleanLLMResponse(text: string): string {
  const fullText = text.trim();
  let searchText = fullText;

  const blockMatch = fullText.match(/```(?:json|JSON)?\s*\n?/);
  if (blockMatch?.index !== undefined) {
    const inner = fullText.slice(blockMatch.index + blockMatch[0].length);
    const innerLeading = inner.trimStart();
    if (innerLeading.startsWith("{") || innerLeading.startsWith("[")) {
      searchText = inner;
    }
  }

  const firstBrace = searchText.indexOf("{");
  const firstBracket = searchText.indexOf("[");

  let startPos = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startPos = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startPos = firstBrace;
  } else if (firstBracket !== -1) {
    startPos = firstBracket;
  }

  let cleaned = searchText;
  if (startPos !== -1) {
    const endIdx = endIndexOfBalancedJson(searchText, startPos);
    cleaned =
      endIdx !== null ? searchText.substring(startPos, endIdx + 1) : searchText.substring(startPos);
  }

  cleaned = cleaned.replace(/\n?```\s*$/, "");

  return cleaned.trim();
}

function formatSchemaErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? `Field "${issue.path.join(".")}"` : "Data";
    return `${path}: ${issue.message}`;
  });
}

/** Create a JSON parser that also validates against the provided Zod schema. */
export function createJsonOutputParser<T = unknown>(schema: z.ZodType<T>): OutputParser<T> {
  return {
    id: "json",
    parse(rawText: string): ParseResult<T> {
      const cleanedText = cleanLLMResponse(rawText);
      const trimmed = cleanedText.trim();

      if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        return {
          success: false,
          failureType: "no_content",
          errors: [
            "[no_content] No JSON object or array found after cleaning the response. Output a raw `{...}` / `[...]` value or wrap it in a ```json fenced block.",
          ],
        };
      }

      let parsedData: unknown;
      try {
        parsedData = JSON.parse(cleanedText);
      } catch (error) {
        return {
          success: false,
          failureType: "parse_error",
          errors: [
            `[parse_error] Invalid parser output: ${(error as Error).message}. Fix the output structure so it can be parsed successfully.`,
          ],
        };
      }

      const validationResult = schema.safeParse(parsedData);
      if (!validationResult.success) {
        return {
          success: false,
          failureType: "schema",
          issues: validationResult.error.issues,
          errors: formatSchemaErrors(validationResult.error.issues),
        };
      }

      return {
        success: true,
        data: validationResult.data,
      };
    },
  };
}
