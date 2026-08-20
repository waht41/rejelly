import { describe, expect, it, vi } from "vitest";
import type { McpBoundRoute, McpDispatchBinding } from "../contracts";
import {
  createMcpGatewayToolsForDispatch,
  createUnavailableMcpDispatch,
  referenceMcpTools,
} from "./dispatch";

function route(serverId: string, nativeToolName: string): McpBoundRoute {
  return {
    identity: { serverId, nativeToolName },
    description: `Read ${serverId} documentation`,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    configFingerprint: `config-${serverId}`,
    catalogRevision: `catalog-${serverId}`,
  };
}

function binding(): McpDispatchBinding {
  const routes = [route("alpha", "read"), route("beta", "read")];
  return {
    bindingId: "binding-1",
    generation: 1,
    servers: [
      {
        serverId: "alpha",
        configFingerprint: "config-alpha",
        status: "ready",
        catalogRevision: "catalog-alpha",
        tools: [
          {
            nativeToolName: "read",
            description: "Read alpha documentation",
            inputSchema: routes[0]!.inputSchema,
          },
        ],
      },
      {
        serverId: "beta",
        configFingerprint: "config-beta",
        status: "ready",
        catalogRevision: "catalog-beta",
        tools: [
          {
            nativeToolName: "read",
            description: "Read beta documentation",
            inputSchema: routes[1]!.inputSchema,
          },
        ],
      },
      {
        serverId: "pending",
        configFingerprint: "config-pending",
        status: "pending",
        tools: [],
      },
      {
        serverId: "workspace",
        configFingerprint: "config-workspace",
        status: "untrusted",
        tools: [],
      },
    ],
    route: (identity) =>
      routes.find(
        (candidate) =>
          candidate.identity.serverId === "alpha" &&
          candidate.identity.serverId === identity.serverId &&
          candidate.identity.nativeToolName === identity.nativeToolName,
      ),
  };
}

describe("MCP dispatch gateway", () => {
  it("keeps stable unavailable gateway tools without an MCP runtime", async () => {
    const tools = createMcpGatewayToolsForDispatch(createUnavailableMcpDispatch());

    expect(tools.map((tool) => tool.name)).toEqual(["mcp_reference", "mcp_call"]);
    await expect(tools[0].handler({ query: "typescript" })).resolves.toEqual({
      type: "mcp_reference_v1",
      matches: [],
    });
    await expect(
      tools[1].handler({
        tool: { serverId: "typescript", nativeToolName: "get_definition" },
        catalogRevision: "catalog-1",
        arguments: {},
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "tool_unavailable" });
  });

  it("references same-named tools and reports unavailable servers with actions", () => {
    const result = referenceMcpTools(binding(), { query: "read documentation" });

    expect(result.matches.map((match) => match.identity)).toEqual([
      { serverId: "alpha", nativeToolName: "read" },
      { serverId: "beta", nativeToolName: "read" },
    ]);
    expect(result.matches.map((match) => match.callable)).toEqual([true, false]);
    expect(result.unavailableServers).toEqual([
      { serverId: "pending", status: "pending", suggestedAction: "wait" },
      { serverId: "workspace", status: "untrusted", suggestedAction: "select_and_trust" },
    ]);
    expect(
      referenceMcpTools(binding(), { query: "read", serverIds: ["beta"] }).matches.map(
        (match) => match.identity,
      ),
    ).toEqual([{ serverId: "beta", nativeToolName: "read" }]);
    expect(
      referenceMcpTools(binding(), { query: "read", serverIds: ["beta"] }).unavailableServers,
    ).toBeUndefined();
  });

  it("treats an exact asterisk query as a bounded visible-tool listing", () => {
    const result = referenceMcpTools(binding(), { query: "*", maxResults: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.identity).toEqual({ serverId: "alpha", nativeToolName: "read" });
  });

  it("keeps a dispatched call bound to the invocation port from its own tool batch", async () => {
    const firstInvoke = vi.fn(async () => ({
      ok: true as const,
      result: { content: [{ type: "text", text: "first" }] },
    }));
    const secondInvoke = vi.fn(async () => ({
      ok: true as const,
      result: { content: [{ type: "text", text: "second" }] },
    }));
    const firstTools = createMcpGatewayToolsForDispatch({
      binding: binding(),
      invoke: firstInvoke,
    });
    createMcpGatewayToolsForDispatch({ binding: binding(), invoke: secondInvoke });

    const result = await firstTools[1].handler({
      tool: { serverId: "alpha", nativeToolName: "read" },
      catalogRevision: "catalog-alpha",
      arguments: { path: "guide.md" },
    });

    expect(result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "first" }] },
    });
    expect(firstInvoke).toHaveBeenCalledOnce();
    expect(secondInvoke).not.toHaveBeenCalled();
  });
});
