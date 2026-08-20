/** Process-owned MCP runtime projection into per-dispatch gateway bindings. */

import type { ToolConfirmationHandler } from "../../shared/host/toolConfirmationBindings";
import type { McpBoundRoute } from "./contracts";
import type { McpDispatchBindingFactory } from "./gateway/dispatch";
import type { McpRuntimeManager } from "./runtime/runtimeManager";

export const MCP_RUNTIME_RESOURCE_KEY = "mcp:runtime";

export function createMcpRuntimeProviders(manager: McpRuntimeManager): Record<string, unknown> {
  return { [MCP_RUNTIME_RESOURCE_KEY]: manager };
}

/**
 * Capture a new binding at each model boundary. The returned dispatch owns the approval and
 * freshness path for exactly the tool batch created from that binding.
 */
export function createMcpDispatchBindingFactory(
  manager: McpRuntimeManager,
  confirmTool: ToolConfirmationHandler,
): McpDispatchBindingFactory {
  return async (selectedServerIds = []) => {
    const required = await manager.waitForRequiredServers("chat", selectedServerIds);
    const failures = required.filter((server) => server.status !== "ready");
    if (failures.length > 0) {
      throw new Error(
        `Required MCP server(s) unavailable: ${failures
          .map(
            (server) =>
              `${server.serverId} (${server.status}${server.error ? `: ${server.error}` : ""})`,
          )
          .join(", ")}`,
      );
    }
    const binding = manager.captureDispatchBinding("chat", selectedServerIds);
    return Object.freeze({
      binding,
      invoke: async (route: McpBoundRoute, argumentsValue: Record<string, unknown>) => {
        const decision = await confirmTool({
          type: "mcp_call",
          tool: route.identity,
          arguments: argumentsValue,
        });
        if (decision.action !== "accept") {
          return {
            ok: false as const,
            code: "approval_denied" as const,
            message: "The MCP tool call was denied by the user.",
          };
        }
        return manager.callBoundTool("chat", route, argumentsValue);
      },
    });
  };
}
