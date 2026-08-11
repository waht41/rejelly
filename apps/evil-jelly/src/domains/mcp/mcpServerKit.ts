/**
 * Optional MCP server wiring for evil-jelly.
 *
 * Currently a single internal entry: the `rejelly-devtool` MCP server (HTTP route
 * on the devtool-server), which lets evil introspect its OWN run via the trace DB
 * — messages, tool calls, trace profile, etc.
 *
 * Shaped as a descriptor LIST on purpose, even though there is one entry today:
 * adding a server later is a list entry, not new plumbing. It is deliberately NOT
 * a user-facing / config-file registry yet — that (bring-your-own MCP from
 * settings) is a separate, larger product surface (process spawning, env
 * injection, failure isolation, UI) and is out of scope here.
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
import { getReviewEndpointFromEnv } from "../../shared/config";
import { evilJellyToolLoggerMiddleware } from "../../shared/host/withToolLogger";

export interface McpProviderConnectionOptions {
  /** Per-run opt-in resolved by the CLI composition boundary. */
  devtoolMcp: boolean;
}

interface McpServerDescriptor {
  /** Provider key suffix (`mcp:<id>`) + equipMCP clientId. */
  id: string;
  /** Tool name prefix, e.g. `devtool_get_trace_profile`. Avoids collisions and groups the set. */
  namespace: string;
  /** Opt-in gate, checked at connect time only. Returning false skips the server entirely. */
  enabled: (options: McpProviderConnectionOptions) => boolean;
  /** Endpoint URL of the MCP server (resolved lazily, at connect time). */
  url: () => string;
}

/**
 * The devtool MCP route (`/mcp`) lives on the SAME origin as the Review trace
 * ingest endpoint, so it is derived from the one endpoint evil already configures
 * — no second URL to keep in sync.
 */
function devtoolMcpUrl(): string {
  const origin = new URL(getReviewEndpointFromEnv()).origin;
  return `${origin}/mcp`;
}

const MCP_SERVERS: McpServerDescriptor[] = [
  {
    id: "devtool",
    namespace: "devtool",
    // Introspection only makes sense when the devtool server is up AND traces are
    // being exported to it, so this is opt-in via --devtool (separate from --review).
    // Best-effort connect means a wrong guess simply no-ops rather than breaking evil.
    enabled: (options) => options.devtoolMcp,
    url: devtoolMcpUrl,
  },
];

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
 * Connect enabled MCP servers at the composition-root boundary (ABOVE runWith), so the
 * connection lives for the whole process/session and is reused across run segments.
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
  for (const server of MCP_SERVERS) {
    if (!server.enabled(options)) continue;
    try {
      const client = await connectMcpClient(server.url());
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
  for (const server of MCP_SERVERS) {
    const client = expectResource<Client>(resourceKey(server.id), { optional: true });
    if (!client) continue;
    try {
      const kit = await equipMCP(client, {
        clientId: server.id,
        namespace: server.namespace,
        middleware,
      });
      kit.inject();
    } catch (error) {
      warnFailure(server.id, "equip", error);
    }
  }
}
