import type { ToolDefinition } from "@rejelly/core";
import {
  MCP_CALL_TOOL_DESCRIPTION,
  MCP_CALL_TOOL_NAME,
  MCP_REFERENCE_TOOL_DESCRIPTION,
  MCP_REFERENCE_TOOL_NAME,
  MCP_REQUEST_TOOL_DESCRIPTION,
  MCP_REQUEST_TOOL_NAME,
  type McpCallInput,
  type McpReferenceInput,
  type McpReferenceResult,
  type McpRequestInput,
  type McpRequestResult,
  mcpCallInputSchema,
  mcpReferenceInputSchema,
  mcpRequestInputSchema,
} from "../contracts";
import { projectMcpCallResultForModel } from "./callResultProjection";
import type { McpCallPolicy } from "./mcpCallPolicy";
import { projectMcpReferenceForModel } from "./referenceProjection";

export interface McpGatewayToolPorts {
  readonly reference: (input: McpReferenceInput) => Promise<McpReferenceResult>;
  readonly callPolicy: McpCallPolicy;
}

export interface McpChatGatewayToolPorts extends McpGatewayToolPorts {
  readonly request: (input: McpRequestInput) => Promise<McpRequestResult>;
}

export type McpGatewayToolDefinitions = readonly [
  ToolDefinition<typeof mcpReferenceInputSchema>,
  ToolDefinition<typeof mcpCallInputSchema>,
];

export type McpChatGatewayToolDefinitions = readonly [
  ToolDefinition<typeof mcpReferenceInputSchema>,
  ToolDefinition<typeof mcpRequestInputSchema>,
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
    handler: async (input: McpReferenceInput) =>
      projectMcpReferenceForModel(await ports.reference(input)),
  });
  const callTool: ToolDefinition<typeof mcpCallInputSchema> = Object.freeze({
    name: MCP_CALL_TOOL_NAME,
    description: MCP_CALL_TOOL_DESCRIPTION,
    parameters: mcpCallInputSchema,
    handler: async (input: McpCallInput) =>
      projectMcpCallResultForModel(await ports.callPolicy.execute(input)),
  });
  return Object.freeze([referenceTool, callTool]);
}

/** Chat adds a fixed access-request gateway; Audit deliberately keeps the two-tool surface. */
export function createMcpChatGatewayToolDefinitions(
  ports: McpChatGatewayToolPorts,
): McpChatGatewayToolDefinitions {
  const [referenceTool, callTool] = createMcpGatewayToolDefinitions(ports);
  const requestTool: ToolDefinition<typeof mcpRequestInputSchema> = Object.freeze({
    name: MCP_REQUEST_TOOL_NAME,
    description: MCP_REQUEST_TOOL_DESCRIPTION,
    parameters: mcpRequestInputSchema,
    handler: (input: McpRequestInput) => ports.request(input),
  });
  return Object.freeze([referenceTool, requestTool, callTool]);
}
