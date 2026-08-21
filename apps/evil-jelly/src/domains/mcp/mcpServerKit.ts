/** Process-owned MCP runtime projection into per-dispatch gateway bindings. */

import type { ToolConfirmationHandler } from "../../shared/host/toolConfirmationBindings";
import type { McpBoundRoute, McpReferenceInput, McpRequestInput } from "./contracts";
import {
  type McpCallAuthorizationHandler,
  type McpDispatchBindingFactory,
  referenceMcpTools,
} from "./gateway/dispatch";
import { fingerprintMcpToolSchema } from "./permissions";
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
  options: {
    readonly persistentServerIds?: () => readonly string[];
    readonly onStartupWait?: (serverIds: readonly string[]) => (() => void) | undefined;
  } = {},
): McpDispatchBindingFactory {
  return async (selectedServerIds = [], authorizeCall?: McpCallAuthorizationHandler) => {
    const effectiveServerIds = [
      ...new Set([...selectedServerIds, ...(options.persistentServerIds?.() ?? [])]),
    ].sort();
    await manager.activateServers("chat", effectiveServerIds);
    const required = await manager.waitForRequiredServers("chat", effectiveServerIds);
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
    const binding = manager.captureDispatchBinding("chat", effectiveServerIds);
    return Object.freeze({
      binding,
      reference: async (input: McpReferenceInput) => {
        await manager.waitForReferenceServers("chat", effectiveServerIds, input.serverIds, {
          onWaitStart: options.onStartupWait,
        });
        return referenceMcpTools(manager.captureDispatchBinding("chat", effectiveServerIds), input);
      },
      request: async (input: McpRequestInput) => ({
        type: "mcp_request_v1" as const,
        serverId: input.serverId,
        status: "unavailable" as const,
        code: "runtime_unavailable" as const,
        message: "MCP access requests are unavailable in this host.",
      }),
      invoke: async (route: McpBoundRoute, argumentsValue: Record<string, unknown>) => {
        if (authorizeCall) {
          if (await authorizeCall(route, argumentsValue)) {
            return manager.callBoundTool("chat", route, argumentsValue);
          }
          return {
            ok: false as const,
            code: "approval_denied" as const,
            message: "The MCP tool call was denied by the user.",
          };
        }
        const decision = await confirmTool({
          type: "mcp_call",
          tool: route.identity,
          configFingerprint: route.configFingerprint,
          toolSchemaFingerprint: fingerprintMcpToolSchema(route),
          autoApprovedByPolicy: false,
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
