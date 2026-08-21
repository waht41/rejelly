/**
 * Pure bridge: one MCP tool descriptor -> framework ToolDefinition
 */

import type { JsonSchema, ToolDefinition } from "@rejelly/core";
import { jsonSchemaToZod } from "./json-schema-to-zod";
import {
  formatCallToolResult,
  type MCPClientLike,
  type McpToolListItem,
  normalizeCallTool,
} from "./mcp-compat";

export interface FromMCPToolOptions {
  /** Registered tool name; default is MCP tool name */
  name?: string;
}

/**
 * Convert a single MCP tool (JSON Schema input) into a ToolDefinition with Zod parameters.
 * The handler proxies to client.callTool (SDK or compatible).
 */
export function fromMCPTool(
  mcpTool: McpToolListItem,
  client: MCPClientLike,
  options?: FromMCPToolOptions,
): ToolDefinition {
  const toolName = options?.name ?? mcpTool.name;
  const zodSchema = jsonSchemaToZod(mcpTool.inputSchema as JsonSchema, mcpTool.name);

  return {
    name: toolName,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    parameters: zodSchema,
    handler: async (args) => {
      const raw = await normalizeCallTool(client, mcpTool.name, args as Record<string, unknown>);
      return formatCallToolResult(raw);
    },
  };
}
