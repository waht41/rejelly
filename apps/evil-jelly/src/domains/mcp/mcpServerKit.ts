/**
 * Optional MCP server wiring for evil-jelly.
 *
 * T2 compatibility projection from the process-owned runtime manager into the legacy `equipMCP`
 * surface. T3 replaces the per-server native tool injection with the two stable gateway tools.
 *
 * The composition root seeds one borrowed manager resource into `runWith({ providers })`.
 * Connection ownership and disposal stay at the process boundary.
 */

import { equipMCP, type MCPClientAdapter } from "@rejelly/adapter-mcp";
import { expectResource } from "@rejelly/core";
import { evilJellyToolLoggerMiddleware } from "../../shared/tool-observation/middleware";
import type { McpRuntimeManager } from "./runtime/runtimeManager";

export const MCP_RUNTIME_RESOURCE_KEY = "mcp:runtime";

function warnFailure(id: string, phase: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mcp:${id}] ${phase} failed (continuing without these tools): ${message}`);
}

export function createMcpRuntimeProviders(manager: McpRuntimeManager): Record<string, unknown> {
  return { [MCP_RUNTIME_RESOURCE_KEY]: manager };
}

function namespaceFor(serverId: string): string {
  const normalized = serverId.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(normalized) ? normalized : `mcp_${normalized}`;
}

export interface McpServerKitOptions {
  /**
   * Equip without the host print/log middleware, for background/concurrent sub-agents whose tool
   * chatter must not interleave on the shared terminal. Mirrors
   * {@link ReadOnlyWorkspaceKitOptions.quiet} in kits.ts.
   */
  quiet?: boolean;
}

/**
 * Register tools for clients ready at agent construction time. Late readiness is intentionally
 * non-blocking and becomes fully dynamic when T3 installs stable gateway tools.
 *
 * Call inside the agent handler BEFORE promptAgent (same contract as the other equip*
 * kits — equipMCP throws AfterPromptAgentError otherwise).
 *
 * NOTE (self-identity): the devtool tools default to the latest trace in the DB when no
 * `traceId` is passed. In a live single-user CLI session that is almost always evil's own
 * current run, so it works today. To make "my own run" guaranteed rather than heuristic,
 * thread the run traceId into props and inject it via tool middleware here — left as a
 * follow-up (ConversationAgentProps has no traceId yet).
 */
export async function equipMcpServerKit(options: McpServerKitOptions = {}): Promise<void> {
  const middleware = options.quiet ? [] : [evilJellyToolLoggerMiddleware];
  const manager = expectResource<McpRuntimeManager>(MCP_RUNTIME_RESOURCE_KEY, { optional: true });
  if (!manager) return;
  for (const serverId of manager.getReadyServerIds()) {
    const client = manager.getReadyClient(serverId);
    if (!client) continue;
    try {
      const kit = await equipMCP(client as MCPClientAdapter, {
        clientId: serverId,
        namespace: namespaceFor(serverId),
        middleware,
      });
      kit.inject();
    } catch (error) {
      warnFailure(serverId, "equip", error);
    }
  }
}
