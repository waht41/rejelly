import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callMcpTool, loadMcpToolCatalog, normalizeMcpToolCatalog } from "@rejelly/adapter-mcp";
import stripAnsi from "strip-ansi";
import { resolveWorkspaceCwd } from "../../../shared/fs-policy/workspace-fs-policy";
import {
  type McpEnvironmentResolver,
  resolveMcpValueSources,
} from "../configuration/configuration";
import type { McpDesiredServer, McpValueSource } from "../contracts";
import {
  McpRuntimeEventError,
  mcpStartupCancelledError,
  mcpStartupTimeoutError,
} from "./runtimeFailure";
import type {
  McpRuntimeConnection,
  McpRuntimeConnectionCallbacks,
  McpRuntimeConnector,
} from "./runtimeManager";

export interface SdkMcpRuntimeConnectorOptions {
  readonly workspaceRoot: string;
  readonly resolveEnvironment: McpEnvironmentResolver;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

const MCP_STDIO_STDERR_TAIL_CHARS = 4_096;

function captureStdioStderr(transport: StdioClientTransport): () => string {
  let tail = "";
  transport.stderr?.on("data", (chunk) => {
    tail = `${tail}${stripAnsi(String(chunk))}`.slice(-MCP_STDIO_STDERR_TAIL_CHARS);
  });
  return () => tail.trim();
}

function secretValues(sources: Readonly<Record<string, McpValueSource>>): string[] {
  return Object.values(sources)
    .filter((source): source is { value: string } => "value" in source)
    .map((source) => source.value)
    .filter((value) => value.length >= 3);
}

function safeConnectionError(error: unknown, secrets: readonly string[], suffix?: string): Error {
  let message = `${error instanceof Error ? error.message : String(error)}${suffix ?? ""}`;
  for (const secret of secrets) message = message.replaceAll(secret, "<redacted>");
  return error instanceof McpRuntimeEventError
    ? new McpRuntimeEventError(error.failureCode, message)
    : new Error(message);
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
  if (signal.aborted) throw mcpStartupCancelledError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(mcpStartupTimeoutError(timeoutMs)), timeoutMs);
        onAbort = () => reject(mcpStartupCancelledError());
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
    throw mcpStartupCancelledError();
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
    let readStderrTail = () => "";
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
              onChanged: (error, tools) => {
                if (error || !tools) {
                  callbacks.onToolsChanged(
                    error ? safeConnectionError(error, resolvedSecrets) : null,
                    null,
                  );
                  return;
                }
                try {
                  callbacks.onToolsChanged(null, normalizeMcpToolCatalog(tools));
                } catch (normalizationError) {
                  callbacks.onToolsChanged(
                    safeConnectionError(normalizationError, resolvedSecrets),
                    null,
                  );
                }
              },
            },
          },
        },
      );
      client.onclose = () => {
        const stderrTail = readStderrTail();
        callbacks.onClose(
          stderrTail
            ? safeConnectionError(
                new Error(`MCP connection closed\nMCP server stderr:\n${stderrTail}`),
                resolvedSecrets,
              )
            : undefined,
        );
      };
      client.onerror = (error) => callbacks.onError(safeConnectionError(error, resolvedSecrets));

      const transport = (() => {
        if (server.definition.transport.type === "stdio") {
          const stdioTransport = new StdioClientTransport({
            command: server.definition.transport.command,
            args: [...server.definition.transport.args],
            cwd: resolveWorkspaceCwd(this.options.workspaceRoot, server.definition.transport.cwd),
            env: {
              ...getDefaultEnvironment(),
              ...resolveForConnection(server.definition.transport.env),
            },
            // The SDK defaults to inherited stderr, which bypasses Ink and corrupts the TUI.
            stderr: "pipe",
          });
          readStderrTail = captureStdioStderr(stdioTransport);
          return stdioTransport;
        }
        return new StreamableHTTPClientTransport(new URL(server.definition.transport.url), {
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
      })();

      await connectWithBoundary(client, transport, signal, server.definition.startupTimeoutMs);
      return {
        client,
        listTools: async () => {
          try {
            return loadMcpToolCatalog({
              listTools: (params) =>
                client.listTools(params, {
                  timeout: server.definition.toolTimeoutMs,
                }),
            });
          } catch (error) {
            throw safeConnectionError(error, resolvedSecrets);
          }
        },
        callTool: async (name, argumentsValue) => {
          try {
            return await callMcpTool(
              {
                callTool: (params) =>
                  client.callTool(params, undefined, {
                    timeout: server.definition.toolTimeoutMs,
                  }),
              },
              name,
              argumentsValue,
            );
          } catch (error) {
            throw safeConnectionError(error, resolvedSecrets);
          }
        },
        close: () => client.close(),
      };
    } catch (error) {
      const stderrTail = readStderrTail();
      throw safeConnectionError(
        error,
        resolvedSecrets,
        stderrTail ? `\nMCP server stderr:\n${stderrTail}` : undefined,
      );
    }
  }
}
