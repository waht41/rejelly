import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMcpServerDefinition } from "../configuration/configuration";
import type { McpDesiredServer } from "../contracts";
import { SdkMcpRuntimeConnector } from "./sdkConnector";

const sdkMocks = vi.hoisted(() => ({
  stdioParameters: [] as unknown[],
  connectError: undefined as Error | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", async () => {
  const { PassThrough } = await import("node:stream");
  return {
    getDefaultEnvironment: () => ({}),
    StdioClientTransport: class {
      readonly stderr = new PassThrough();

      constructor(parameters: unknown) {
        sdkMocks.stdioParameters.push(parameters);
      }
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose: (() => void) | undefined;
    onerror: ((error: Error) => void) | undefined;

    async connect(transport: { stderr: { write(chunk: string): void } }): Promise<void> {
      transport.stderr.write("server diagnostic\n");
      if (sdkMocks.connectError) throw sdkMocks.connectError;
    }

    async close(): Promise<void> {}
  },
}));

function server(): McpDesiredServer {
  return {
    id: "docs",
    source: { kind: "user" },
    definition: defaultMcpServerDefinition({
      transport: { type: "stdio", command: "mcp-server" },
    }),
  };
}

describe("SDK MCP connector stdio boundary", () => {
  beforeEach(() => {
    sdkMocks.stdioParameters.length = 0;
    sdkMocks.connectError = undefined;
  });

  it("pipes and drains server stderr instead of inheriting the interactive terminal", async () => {
    const connector = new SdkMcpRuntimeConnector({
      workspaceRoot: process.cwd(),
      resolveEnvironment: () => undefined,
    });

    await connector.connect(server(), new AbortController().signal, {
      onClose: vi.fn(),
      onError: vi.fn(),
      onToolsChanged: vi.fn(),
    });

    expect(sdkMocks.stdioParameters).toEqual([
      expect.objectContaining({ command: "mcp-server", stderr: "pipe" }),
    ]);
  });

  it("attaches a bounded stderr tail to startup failures", async () => {
    sdkMocks.connectError = new Error("handshake failed");
    const connector = new SdkMcpRuntimeConnector({
      workspaceRoot: process.cwd(),
      resolveEnvironment: () => undefined,
    });

    await expect(
      connector.connect(server(), new AbortController().signal, {
        onClose: vi.fn(),
        onError: vi.fn(),
        onToolsChanged: vi.fn(),
      }),
    ).rejects.toThrow("handshake failed\nMCP server stderr:\nserver diagnostic");
  });
});
