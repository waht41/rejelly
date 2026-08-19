import type { ToolDefinition } from "@rejelly/core";
import {
  MCP_CALL_TOOL_DESCRIPTION,
  MCP_CALL_TOOL_NAME,
  MCP_REFERENCE_TOOL_DESCRIPTION,
  MCP_REFERENCE_TOOL_NAME,
  type McpCallInput,
  type McpReferenceInput,
  type McpReferenceResult,
  mcpCallInputSchema,
  mcpReferenceInputSchema,
} from "../contracts";
import type { McpCallPolicy } from "./mcpCallPolicy";

export interface McpGatewayToolPorts {
  readonly reference: (input: McpReferenceInput) => Promise<McpReferenceResult>;
  readonly callPolicy: McpCallPolicy;
}

export type McpGatewayToolDefinitions = readonly [
  ToolDefinition<typeof mcpReferenceInputSchema>,
  ToolDefinition<typeof mcpCallInputSchema>,
];

/** Handler wiring may vary per dispatch; provider-facing names and schemas never do. */
export function createMcpGatewayToolDefinitions(
  ports: McpGatewayToolPorts,
): McpGatewayToolDefinitions {
  const referenceTool: ToolDefinition<typeof mcpReferenceInputSchema> = Object.freeze({
    name: MCP_REFERENCE_TOOL_NAME,
    description: MCP_REFERENCE_TOOL_DESCRIPTION,
    parameters: mcpReferenceInputSchema,
    handler: (input: McpReferenceInput) => ports.reference(input),
  });
  const callTool: ToolDefinition<typeof mcpCallInputSchema> = Object.freeze({
    name: MCP_CALL_TOOL_NAME,
    description: MCP_CALL_TOOL_DESCRIPTION,
    parameters: mcpCallInputSchema,
    handler: (input: McpCallInput) => ports.callPolicy.execute(input),
  });
  return Object.freeze([referenceTool, callTool]);
}
