/**
 * MCP Adapter (Model Context Protocol)
 *
 * Bridges an already-connected MCP client into Rejelly tools (schema mapping + proxy calls).
 * Transport and process lifecycle stay outside this package.
 *
 * @packageDocumentation
 */

export { equipMCP } from "./equip";
export { fromMCPTool } from "./from-mcp-tool";
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
