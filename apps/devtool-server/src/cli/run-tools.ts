/**
 * `rejelly-devtool tools` — run the devtool trace-analysis tools directly
 * against the local trace DB, headless. Useful as an eval harness for the
 * same tools the MCP server and AI agents expose.
 *
 * DB path follows the server: --db flag, else REJELLY_DEVTOOL_DB_PATH env, else
 * ./.rejelly/devtool.sqlite3 (cwd). Run from the package dir (or pass --db) to
 * target apps/devtool-server/.rejelly/devtool.sqlite3.
 */

import type { ToolDefinition } from "@rejelly/core";
import { transferJsonSchema } from "@rejelly/core/policy";
import { ZodError, type ZodTypeAny, z } from "zod";
import { getAbsoluteDbPath } from "../config";
import { createTraceTools, resolveContext, type TraceContext } from "../tools/registry.js";

export interface RunToolsOptions {
  list?: boolean;
  describe?: string;
  tool?: string;
  args?: string;
  traceId?: string;
  json?: boolean;
}

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodEffects
  ) {
    current =
      current instanceof z.ZodEffects
        ? current.innerType()
        : (current._def.innerType as ZodTypeAny);
  }
  return current;
}

function objectShape(parameters: ZodTypeAny): Record<string, ZodTypeAny> {
  const unwrapped = unwrapSchema(parameters);
  if (!(unwrapped instanceof z.ZodObject)) {
    throw new Error("Tool parameters must be a Zod object schema.");
  }
  return unwrapped.shape;
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "args";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

export function parseToolArgs(tool: ToolDefinition, argsJson?: string): Record<string, unknown> {
  if (!argsJson) return tool.parameters.parse({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch (error) {
    throw new Error(
      `Invalid --args JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return tool.parameters.parse(parsed);
}

function sampleValue(schema: ZodTypeAny): unknown {
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof z.ZodString) return "string";
  if (unwrapped instanceof z.ZodNumber) return 1;
  if (unwrapped instanceof z.ZodBoolean) return true;
  if (unwrapped instanceof z.ZodEnum) return unwrapped.options[0];
  if (unwrapped instanceof z.ZodArray) return [sampleValue(unwrapped.element)];
  if (unwrapped instanceof z.ZodTuple) {
    return (unwrapped._def.items as ZodTypeAny[]).map((item) => sampleValue(item));
  }
  if (unwrapped instanceof z.ZodUnion) {
    return sampleValue((unwrapped._def.options as ZodTypeAny[])[0]);
  }
  return {};
}

function isOptionalParameter(schema: ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

export function describeTool(tool: ToolDefinition): Record<string, unknown> {
  const shape = objectShape(tool.parameters);
  const entries = Object.entries(shape);
  const argsExample = Object.fromEntries(
    entries.map(([name, schema]) => [name, sampleValue(schema)]),
  );
  const required = entries
    .filter(([, schema]) => !isOptionalParameter(schema))
    .map(([name]) => name);
  const optional = entries
    .filter(([, schema]) => isOptionalParameter(schema))
    .map(([name]) => name);

  return {
    name: tool.name,
    description: tool.description,
    parameters: transferJsonSchema(tool.parameters),
    required,
    optional,
    argsExample,
  };
}

/**
 * Execute the `tools` subcommand. Throws on bad input; the caller maps that
 * to a non-zero exit code.
 */
export async function runTools(options: RunToolsOptions): Promise<void> {
  const evalTools = await createTraceTools();
  const describeContext: TraceContext = { defaultTraceDescription: "the latest trace" };

  if (options.list) {
    for (const evalTool of evalTools) {
      const tool = evalTool.createTool(describeContext);
      console.log(`${tool.name}\t${tool.description}`);
    }
    return;
  }

  if (options.describe) {
    const evalTool = evalTools.find((tool) => tool.name === options.describe);
    if (!evalTool) throw new Error(`No tool registered for: ${options.describe}`);
    console.log(JSON.stringify(describeTool(evalTool.createTool(describeContext)), null, 2));
    return;
  }

  const selectedTools = options.tool
    ? evalTools.filter((tool) => tool.name === options.tool)
    : evalTools;

  if (selectedTools.length === 0) {
    throw new Error(`No tool registered for: ${options.tool}`);
  }

  const { context, note } = await resolveContext(
    {
      defaultTraceDescription: options.traceId
        ? "the trace passed with --trace-id"
        : "the latest trace",
    },
    { traceId: options.traceId },
  );
  const traceId = context.traceId;
  const invocations: Array<{ tool: ToolDefinition; args: Record<string, unknown> }> = [];
  const defaultRun = !options.tool && !options.args;

  for (const evalTool of selectedTools) {
    const tool = evalTool.createTool(context);
    let args: Record<string, unknown>;
    try {
      args = parseToolArgs(tool, options.args);
    } catch (error) {
      if (defaultRun && error instanceof ZodError) continue;
      if (error instanceof ZodError) {
        throw new Error(`Invalid args for ${tool.name}:\n${formatZodError(error)}`);
      }
      throw error;
    }
    invocations.push({ tool, args });
  }

  if (invocations.length === 0) {
    throw new Error("No selected tool can run without --args.");
  }

  if (!options.json) {
    console.log(`db=${getAbsoluteDbPath()}`);
    console.log(`trace_id=${traceId ?? "(none)"}`);
    if (note) console.log(note);
  }

  const jsonResults: Array<{ tool: string; args: Record<string, unknown>; result: unknown }> = [];

  for (const { tool, args } of invocations) {
    const result = await tool.handler(args);

    if (options.json) {
      jsonResults.push({ tool: tool.name, args, result });
      continue;
    }

    console.log("");
    console.log(`=== ${tool.name} ===`);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }

  if (options.json) {
    console.log(JSON.stringify(jsonResults.length === 1 ? jsonResults[0] : jsonResults, null, 2));
  }
}
