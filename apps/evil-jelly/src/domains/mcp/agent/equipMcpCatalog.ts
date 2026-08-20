import { equipInstruction, expectResource } from "@rejelly/core";
import { MCP_RUNTIME_RESOURCE_KEY } from "../mcpServerKit";
import type { McpRuntimeManager } from "../runtime/runtimeManager";
import { renderMcpServerCatalog } from "./catalogPrompt";

/** Advertise configured chat servers by name; native schemas remain behind mcp_reference. */
export function equipMcpCatalog(): void {
  const manager = expectResource<McpRuntimeManager>(MCP_RUNTIME_RESOURCE_KEY, { optional: true });
  if (!manager) return;
  const catalog = renderMcpServerCatalog(manager.getVisibleServerIds("chat"));
  if (catalog) equipInstruction(catalog);
}
