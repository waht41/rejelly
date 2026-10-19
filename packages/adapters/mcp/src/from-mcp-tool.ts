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
import type { McpCallToolStyle } from "./types";

export interface FromMCPToolOptions {
  /** Registered tool name; default is MCP tool name */
  name?: string;
  /** Native callTool signature. Defaults to the SDK's object-parameter form. */
  callToolStyle?: McpCallToolStyle;
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
      const raw = await normalizeCallTool(
        client,
        mcpTool.name,
        args as Record<string, unknown>,
        options?.callToolStyle,
      );
      return formatCallToolResult(raw);
    },
  };
}
