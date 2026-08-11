import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import type { z } from "zod";

/**
 * Parse JSONC (comments + trailing commas) strictly. jsonc-parser itself is
 * fault-tolerant and always returns a best-effort value, so we surface its
 * error list as a throw with line/column info instead of silently accepting
 * malformed config.
 */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const result: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    throw new Error(`${printParseErrorCode(error)} at line ${line}, column ${column}`);
  }
  return result;
}

export function parseAndValidateJsonc<TSchema extends z.ZodTypeAny>(
  raw: string,
  label: string,
  filePath: string,
  schema: TSchema,
): z.output<TSchema> {
  let json: unknown;
  try {
    json = parseJsonc(raw);
  } catch (e) {
    throw new Error(
      `${label} ${filePath} is not valid JSON(C): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${label} ${filePath} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
