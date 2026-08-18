/**
 * Optional MCP server wiring for evil-jelly.
 *
 * T1 compatibility bridge for the built-in `evil.devtool` dynamic definition. General MCP
 * settings already resolve into the same desired-set contract, but T2's runtime manager owns
 * connecting those user/workspace definitions, trust gating, retries, and replacement.
 *
 * Lifecycle uses the framework's boundary DI: the composition root connects clients
 * via {@link connectMcpProviders}, seeds them into `runWith({ providers })`, and the
 * agent reads them via {@link equipMcpServerKit}. The framework borrows the clients;
 * it never closes them — ownership (connect + dispose) stays at the boundary.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { equipMCP } from "@rejelly/adapter-mcp";
import { expectResource } from "@rejelly/core";
import { evilJellyToolLoggerMiddleware } from "../../shared/tool-observation/middleware";
import type { McpDesiredConfig, McpDesiredServer } from "./contracts";

export interface McpProviderConnectionOptions {
  /** T1 compatibility bridge; T2 hands this desired set to McpRuntimeManager. */
  desiredConfig: McpDesiredConfig;
}

function legacyDevtoolServers(config: McpDesiredConfig): McpDesiredServer[] {
  return config.servers.filter(
    (server) =>
      server.id === "evil.devtool" &&
      server.source.kind === "dynamic" &&
      server.definition.enabled &&
      server.definition.transport.type === "streamableHttp",
  );
}

/** Provider / expectResource key for a server id. Shared by the boundary (seed) and the kit (read). */
function resourceKey(id: string): string {
  return `mcp:${id}`;
}

/** --devtool was explicitly requested, so a failure is worth one loud line — but never a crash. */
function warnFailure(id: string, phase: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mcp:${id}] ${phase} failed (continuing without these tools): ${message}`);
}

async function connectMcpClient(url: string): Promise<Client> {
  const client = new Client({ name: "evil-jelly", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client;
}

export interface McpProviders {
  /**
   * Spread into `runWith({ providers })`. Keyed by `mcp:<id>`; only successfully-connected
   * servers are present, so the agent's expectResource read naturally skips the rest.
   */
  providers: Record<string, unknown>;
  /**
   * Close every connected client. Call at host/process shutdown — the framework borrows
   * these providers but never closes them, so disposal is the boundary's responsibility.
   */
  dispose: () => Promise<void>;
}

/**
 * Connect the dynamic devtool definition at the composition-root boundary (ABOVE runWith), so
 * the compatibility connection lives for the whole process/session and is reused across segments.
 *
 * BEST-EFFORT BY DESIGN: a disabled server is skipped silently; an enabled-but-unreachable
 * server warns on stderr and is omitted — never a throw. The returned `providers` go into
 * `runWith({ providers })`; the agent reads them via expectResource and skips any that are
 * absent — so the devtool server being down just means no introspection that session,
 * never a broken run.
 */
export async function connectMcpProviders(
  options: McpProviderConnectionOptions,
): Promise<McpProviders> {
  const providers: Record<string, unknown> = {};
  const clients: Client[] = [];
  for (const server of legacyDevtoolServers(options.desiredConfig)) {
    try {
      if (server.definition.transport.type !== "streamableHttp") continue;
      const client = await connectMcpClient(server.definition.transport.url);
      providers[resourceKey(server.id)] = client;
      clients.push(client);
    } catch (error) {
      warnFailure(server.id, "connect", error);
    }
  }
  return {
    providers,
    dispose: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
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
 * Register tools for any MCP server whose client was seeded into the run via
 * `runWith({ providers })`. Reads the client through expectResource (boundary DI) — there
 * is NO module-global connection here. An absent provider (disabled / unreachable) is
 * skipped silently.
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
  const serverId = "evil.devtool";
  const client = expectResource<Client>(resourceKey(serverId), { optional: true });
  if (!client) return;
  try {
    const kit = await equipMCP(client, {
      clientId: serverId,
      namespace: "devtool",
      middleware,
    });
    kit.inject();
  } catch (error) {
    warnFailure(serverId, "equip", error);
  }
}
