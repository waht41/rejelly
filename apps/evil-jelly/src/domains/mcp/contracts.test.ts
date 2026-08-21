import { describe, expect, it } from "vitest";
import { validateMcpServerId } from "../../shared/model/mcp/serverIdentity";
import {
  fingerprintMcpConnectionDefinition,
  fingerprintMcpServerDefinition,
  isMcpToolAllowed,
  isMcpToolAutoApproved,
  isReservedMcpServerId,
  MCP_CALL_TOOL_DESCRIPTION,
  MCP_CALL_TOOL_NAME,
  MCP_CONTRACT_LIMITS,
  MCP_REFERENCE_TOOL_DESCRIPTION,
  MCP_REFERENCE_TOOL_NAME,
  MCP_REQUEST_TOOL_DESCRIPTION,
  MCP_REQUEST_TOOL_NAME,
  type McpDesiredConfig,
  type McpServerDefinition,
  mcpCallInputSchema,
  mcpReferenceInputSchema,
  mcpRequestInputSchema,
  validateUserMcpServerId,
} from "./contracts";

function server(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      cwd: ".",
      env: {
        GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" },
        NODE_ENV: { value: "production" },
      },
    },
    enabled: true,
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
    maxConcurrency: 4,
    tools: {
      allow: ["get_file_contents", "search_repositories"],
      deny: ["delete_repository"],
    },
    use: {
      chat: { exposure: "explicit", required: false, autoApproveTools: [] },
      audit: {
        exposure: "always",
        required: false,
        allow: ["get_file_contents"],
        maxCallsPerSeed: 4,
        maxResultBytesPerSeed: 64 * 1024,
      },
    },
    ...overrides,
  };
}

function fingerprint(definition: McpServerDefinition = server()): string {
  return fingerprintMcpServerDefinition("github", definition);
}

describe("MCP server identity", () => {
  it("trims valid ids and preserves punctuation", () => {
    expect(validateMcpServerId("  github.read_v2  ")).toEqual({
      ok: true,
      value: "github.read_v2",
    });
  });

  it.each([
    "",
    "GitHub",
    "github read",
    "-github",
    "github:read",
    "文档",
  ])("rejects invalid server id %j", (serverId) =>
    expect(validateMcpServerId(serverId).ok).toBe(false));

  it("enforces the id length and built-in namespace boundaries", () => {
    expect(validateMcpServerId("a".repeat(MCP_CONTRACT_LIMITS.serverIdChars)).ok).toBe(true);
    expect(validateMcpServerId("a".repeat(MCP_CONTRACT_LIMITS.serverIdChars + 1)).ok).toBe(false);
    expect(isReservedMcpServerId("evil.devtool")).toBe(true);
    expect(validateMcpServerId("evil.devtool").ok).toBe(true);
    expect(validateUserMcpServerId("evil.devtool").ok).toBe(false);
  });

  it("stores desired server identity once instead of mirroring a map key", () => {
    const definition = server();
    const desired: McpDesiredConfig = {
      servers: [{ id: "github", definition, source: { kind: "workspace" } }],
    };

    expect(desired.servers[0]?.id).toBe("github");
    expect(definition).not.toHaveProperty("id");
  });
});

describe("MCP consumer policy", () => {
  it("applies the global ceiling before the Audit allowlist", () => {
    const definition = server();
    expect(isMcpToolAllowed(definition, "chat", "search_repositories")).toBe(true);
    expect(isMcpToolAllowed(definition, "audit", "search_repositories")).toBe(false);
    expect(isMcpToolAllowed(definition, "audit", "get_file_contents")).toBe(true);
    expect(isMcpToolAllowed(definition, "chat", "delete_repository")).toBe(false);
  });

  it("treats an empty global allowlist as zero tools", () => {
    const definition = server({ tools: { allow: [], deny: [] } });
    expect(isMcpToolAllowed(definition, "chat", "get_file_contents")).toBe(false);
    expect(isMcpToolAllowed(definition, "audit", "get_file_contents")).toBe(false);
  });

  it("auto-approves only exact chat tools that remain inside the global ceiling", () => {
    const definition = server({
      use: {
        ...server().use,
        chat: {
          exposure: "explicit",
          required: false,
          autoApproveTools: ["get_file_contents", "delete_repository"],
        },
      },
    });
    expect(isMcpToolAutoApproved(definition, "get_file_contents")).toBe(true);
    expect(isMcpToolAutoApproved(definition, "delete_repository")).toBe(false);
    expect(isMcpToolAutoApproved(definition, "get_file")).toBe(false);
  });

  it("keeps chat always independent from Audit off", () => {
    const definition = server({
      use: {
        chat: { exposure: "always", required: false, autoApproveTools: [] },
        audit: {
          exposure: "off",
          required: false,
          allow: ["get_file_contents"],
          maxCallsPerSeed: 4,
          maxResultBytesPerSeed: 64 * 1024,
        },
      },
    });
    expect(isMcpToolAllowed(definition, "chat", "get_file_contents")).toBe(true);
    expect(isMcpToolAllowed(definition, "audit", "get_file_contents")).toBe(false);
  });
});

describe("MCP definition fingerprint", () => {
  it("is stable across record, set, and duplicate ordering", () => {
    const first = server();
    const reordered = server({
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        cwd: ".",
        env: {
          NODE_ENV: { value: "production" },
          GITHUB_TOKEN: { fromEnv: "GITHUB_TOKEN" },
        },
      },
      tools: {
        allow: ["search_repositories", "get_file_contents", "get_file_contents"],
        deny: ["delete_repository", "delete_repository"],
      },
      use: {
        chat: { exposure: "explicit", required: false, autoApproveTools: [] },
        audit: {
          exposure: "always",
          required: false,
          allow: ["get_file_contents", "get_file_contents"],
          maxCallsPerSeed: 4,
          maxResultBytesPerSeed: 64 * 1024,
        },
      },
    });

    expect(fingerprint(reordered)).toBe(fingerprint(first));
    expect(fingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not read resolved environment secrets", () => {
    const previous = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "first-secret";
      const first = fingerprint();
      process.env.GITHUB_TOKEN = "rotated-secret";
      expect(fingerprint()).toBe(first);
      expect(
        fingerprint(
          server({
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              cwd: ".",
              env: { GITHUB_TOKEN: { fromEnv: "DIFFERENT_TOKEN" } },
            },
          }),
        ),
      ).not.toBe(first);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it("changes when connection or consumer policy intent changes", () => {
    const base = fingerprint();
    expect(
      fingerprint(
        server({
          use: {
            ...server().use,
            chat: { exposure: "always", required: false, autoApproveTools: [] },
          },
        }),
      ),
    ).not.toBe(base);
    expect(
      fingerprint(
        server({
          transport: {
            type: "streamableHttp",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: { fromEnv: "MCP_TOKEN", prefix: "Bearer " } },
          },
        }),
      ),
    ).not.toBe(base);
    expect(fingerprintMcpServerDefinition("renamed", server())).not.toBe(base);
  });

  it("separates transport identity from binding policy identity", () => {
    const original = server();
    const policyChanged = server({
      ...original,
      tools: { ...original.tools, deny: ["delete_repository", "write_file"] },
      toolTimeoutMs: 5_000,
    });
    expect(fingerprintMcpServerDefinition("github", policyChanged)).not.toBe(
      fingerprintMcpServerDefinition("github", original),
    );
    expect(fingerprintMcpConnectionDefinition("github", policyChanged)).toBe(
      fingerprintMcpConnectionDefinition("github", original),
    );
  });
});

describe("stable MCP gateway contract", () => {
  it("keeps fixed names and descriptions independent of configured servers", () => {
    expect({
      reference: { name: MCP_REFERENCE_TOOL_NAME, description: MCP_REFERENCE_TOOL_DESCRIPTION },
      request: { name: MCP_REQUEST_TOOL_NAME, description: MCP_REQUEST_TOOL_DESCRIPTION },
      call: { name: MCP_CALL_TOOL_NAME, description: MCP_CALL_TOOL_DESCRIPTION },
    }).toEqual({
      reference: {
        name: "mcp_reference",
        description:
          "Find configured MCP tools and return their descriptions, input schemas, callability, and availability; use query `*` to list visible tools.",
      },
      request: {
        name: "mcp_request",
        description:
          "Ask the user to trust and enable one configured MCP server for this chat session.",
      },
      call: {
        name: "mcp_call",
        description:
          "Call one previously referenced MCP tool using its structured identity, catalog revision, and JSON object arguments.",
      },
    });
  });

  it("accepts arbitrary nested JSON object arguments", () => {
    expect(
      mcpCallInputSchema.parse({
        tool: { serverId: "github", nativeToolName: "search" },
        catalogRevision: "catalog-1",
        arguments: {
          query: "mcp",
          page: 2,
          flags: [true, null, { nested: ["a", 3] }],
        },
      }),
    ).toEqual({
      tool: { serverId: "github", nativeToolName: "search" },
      catalogRevision: "catalog-1",
      arguments: {
        query: "mcp",
        page: 2,
        flags: [true, null, { nested: ["a", 3] }],
      },
    });
  });

  it("bounds MCP access requests without accepting model-supplied fingerprints", () => {
    expect(
      mcpRequestInputSchema.parse({ serverId: "github", reason: "Search repositories" }),
    ).toEqual({ serverId: "github", reason: "Search repositories" });
    expect(
      mcpRequestInputSchema.safeParse({ serverId: "github", configFingerprint: "model-value" })
        .success,
    ).toBe(false);
  });

  it("rejects non-JSON values and unknown gateway fields", () => {
    expect(
      mcpCallInputSchema.safeParse({
        tool: { serverId: "github", nativeToolName: "search" },
        catalogRevision: "catalog-1",
        arguments: { invalid: undefined },
      }).success,
    ).toBe(false);
    expect(
      mcpCallInputSchema.safeParse({
        tool: { serverId: "github", nativeToolName: "search" },
        catalogRevision: "catalog-1",
        arguments: {},
        selectedServers: ["github"],
      }).success,
    ).toBe(false);
  });

  it("bounds reference requests without embedding a dynamic catalog", () => {
    expect(
      mcpReferenceInputSchema.parse({
        query: "repository search",
        serverIds: ["github"],
        maxResults: MCP_CONTRACT_LIMITS.referenceMaxResults,
      }),
    ).toEqual({
      query: "repository search",
      serverIds: ["github"],
      maxResults: MCP_CONTRACT_LIMITS.referenceMaxResults,
    });
    expect(mcpReferenceInputSchema.safeParse({ query: "x", maxResults: 0 }).success).toBe(false);
  });

  it("freezes the shared contract limits", () => {
    expect(Object.isFrozen(MCP_CONTRACT_LIMITS)).toBe(true);
  });
});
