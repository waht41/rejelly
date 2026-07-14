import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import {
  createTraceTools,
  resolveContext,
  type TraceContext,
  type TraceToolDefinition,
} from "../tools/registry";

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "args";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolResult(result: unknown): CallToolResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: isObject(result) ? result : undefined,
  };
}

function errorToolResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function registerDevtoolMcpTool(
  server: McpServer,
  toolDefinition: TraceToolDefinition,
  baseContext: TraceContext,
) {
  const declaredTool = toolDefinition.createTool(baseContext);

  server.registerTool(
    declaredTool.name,
    {
      description: declaredTool.description,
      inputSchema: declaredTool.parameters,
    },
    async (args: unknown) => {
      try {
        const { context, note } = await resolveContext(baseContext, args);
        const tool = toolDefinition.createTool(context);
        // Handlers read traceId from args first, so a resolved prefix must
        // replace the raw args value or it would win over the resolution.
        const effectiveArgs =
          isObject(args) && typeof args.traceId === "string" && args.traceId !== context.traceId
            ? { ...args, traceId: context.traceId }
            : args;
        const parsedArgs = tool.parameters.parse(effectiveArgs ?? {});
        const result = await tool.handler(parsedArgs);
        const normalized = normalizeToolResult(result);
        if (note) {
          normalized.content.unshift({ type: "text", text: note });
        }
        return normalized;
      } catch (error) {
        if (error instanceof ZodError) {
          return errorToolResult(
            `Invalid args for ${declaredTool.name}:\n${formatZodError(error)}`,
          );
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

export async function createDevtoolMcpServer(context: TraceContext = {}) {
  const baseContext: TraceContext = {
    defaultTraceDescription: "the latest trace",
    ...context,
  };
  const server = new McpServer({
    name: "rejelly-devtool",
    version: "0.1.0",
  });

  const tools = await createTraceTools();
  for (const tool of tools) {
    registerDevtoolMcpTool(server, tool, baseContext);
  }

  return server;
}
