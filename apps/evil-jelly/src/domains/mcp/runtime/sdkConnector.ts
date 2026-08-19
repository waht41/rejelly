import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceCwd } from "../../../shared/fs-policy/workspace-fs-policy";
import {
  type McpEnvironmentResolver,
  resolveMcpValueSources,
} from "../configuration/configuration";
import type { McpDesiredServer, McpValueSource } from "../contracts";
import type {
  McpRuntimeConnection,
  McpRuntimeConnectionCallbacks,
  McpRuntimeConnector,
  McpRuntimeToolDescriptor,
} from "./runtimeManager";

export interface SdkMcpRuntimeConnectorOptions {
  readonly workspaceRoot: string;
  readonly resolveEnvironment: McpEnvironmentResolver;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

function mapTools(tools: readonly Tool[]): McpRuntimeToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
  }));
}

function secretValues(sources: Readonly<Record<string, McpValueSource>>): string[] {
  return Object.values(sources)
    .filter((source): source is { value: string } => "value" in source)
    .map((source) => source.value)
    .filter((value) => value.length >= 3);
}

function safeConnectionError(error: unknown, secrets: readonly string[]): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.replaceAll(secret, "<redacted>");
  return new Error(message);
}

function resolveValues(
  serverId: string,
  sources: Readonly<Record<string, McpValueSource>>,
  resolveEnvironment: McpEnvironmentResolver,
): Readonly<Record<string, string>> {
  const resolved = resolveMcpValueSources(sources, resolveEnvironment);
  if (!resolved.ok) {
    throw new Error(
      `MCP server "${serverId}" is missing environment variables: ${resolved.missingEnvironmentVariables.join(", ")}`,
    );
  }
  return resolved.values;
}

async function connectWithBoundary(
  client: Client,
  transport: StdioClientTransport | StreamableHTTPClientTransport,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) throw new Error("MCP connection cancelled");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`MCP startup timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        onAbort = () => reject(new Error("MCP connection cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) {
    await client.close().catch(() => undefined);
    throw new Error("MCP connection cancelled");
  }
}

export class SdkMcpRuntimeConnector implements McpRuntimeConnector {
  constructor(private readonly options: SdkMcpRuntimeConnectorOptions) {}

  async connect(
    server: McpDesiredServer,
    signal: AbortSignal,
    callbacks: McpRuntimeConnectionCallbacks,
  ): Promise<McpRuntimeConnection> {
    const sourceValues =
      server.definition.transport.type === "stdio"
        ? server.definition.transport.env
        : server.definition.transport.headers;
    const resolvedSecrets = secretValues(sourceValues);
    const resolveForConnection = (
      sources: Readonly<Record<string, McpValueSource>>,
    ): Readonly<Record<string, string>> => {
      const values = resolveValues(server.id, sources, this.options.resolveEnvironment);
      resolvedSecrets.push(...Object.values(values).filter((value) => value.length >= 3));
      return values;
    };
    try {
      const client = new Client(
        {
          name: this.options.clientName ?? "evil-jelly",
          version: this.options.clientVersion ?? "0.1.0",
        },
        {
          listChanged: {
            tools: {
              autoRefresh: true,
              debounceMs: 100,
              onChanged: (error, tools) =>
                callbacks.onToolsChanged(
                  error ? safeConnectionError(error, resolvedSecrets) : null,
                  tools ? mapTools(tools) : null,
                ),
            },
          },
        },
      );
      client.onclose = callbacks.onClose;
      client.onerror = (error) => callbacks.onError(safeConnectionError(error, resolvedSecrets));

      const transport =
        server.definition.transport.type === "stdio"
          ? new StdioClientTransport({
              command: server.definition.transport.command,
              args: [...server.definition.transport.args],
              cwd: resolveWorkspaceCwd(this.options.workspaceRoot, server.definition.transport.cwd),
              env: {
                ...getDefaultEnvironment(),
                ...resolveForConnection(server.definition.transport.env),
              },
            })
          : new StreamableHTTPClientTransport(new URL(server.definition.transport.url), {
              requestInit: {
                headers: resolveForConnection(server.definition.transport.headers),
              },
              reconnectionOptions: {
                initialReconnectionDelay: 1_000,
                maxReconnectionDelay: 1_000,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 0,
              },
            });

      await connectWithBoundary(client, transport, signal, server.definition.startupTimeoutMs);
      return {
        client,
        listTools: async () => {
          try {
            return mapTools(
              (
                await client.listTools(undefined, {
                  timeout: server.definition.toolTimeoutMs,
                })
              ).tools,
            );
          } catch (error) {
            throw safeConnectionError(error, resolvedSecrets);
          }
        },
        close: () => client.close(),
      };
    } catch (error) {
      throw safeConnectionError(error, resolvedSecrets);
    }
  }
}
