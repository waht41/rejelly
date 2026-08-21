/**
 * MCP Adapter (Model Context Protocol)
 *
 * Bridges an already-connected MCP client into Rejelly tools (schema mapping + proxy calls).
 * Transport and process lifecycle stay outside this package.
 *
 * @packageDocumentation
 */

export { equipMCP } from "./equip";
export {
  McpProtocolError,
  type McpProtocolErrorCode,
  type McpProtocolErrorPayload,
} from "./errors";
export { fromMCPTool } from "./from-mcp-tool";
export {
  callMcpTool,
  type LoadMcpToolCatalogOptions,
  loadMcpToolCatalog,
  type McpCallClient,
  type McpCatalogClient,
  type McpJsonSchemaValidationIssue,
  type McpJsonSchemaValidationResult,
  type McpNativeToolDescriptor,
  type McpNormalizedCallResult,
  normalizeMcpCallResult,
  normalizeMcpToolCatalog,
  validateMcpToolArguments,
} from "./gateway";
export type { MCPClientLike, MCPToolDescriptor } from "./mcp-compat";
export type {
  CallToolResult,
  EquipMCPOptions,
  MCPClientAdapter,
  MCPKit,
  MCPPromptsKit,
  MCPResourceDescriptor,
  McpCallToolContentBlock,
} from "./types";
