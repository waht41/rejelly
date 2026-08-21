import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { mcpBoundRouteFixture } from "../__tests__/mcpTestFixtures";
import type { McpCallInput, McpReferenceMatch } from "../contracts";
import { createMcpChatGatewayToolDefinitions } from "./gatewayTools";
import { McpCallPolicy } from "./mcpCallPolicy";

function route(overrides: Partial<McpReferenceMatch> = {}) {
  return mcpBoundRouteFixture({
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 2 } },
      required: ["path"],
      additionalProperties: false,
    },
    configFingerprint: "config-1",
    catalogRevision: "catalog-1",
    ...overrides,
  });
}

function referenceMatch(overrides: Partial<McpReferenceMatch> = {}): McpReferenceMatch {
  return { ...route(overrides), callable: overrides.callable ?? true };
}

function input(overrides: Partial<McpCallInput> = {}): McpCallInput {
  return {
    tool: { serverId: "docs", nativeToolName: "read" },
    catalogRevision: "catalog-1",
    arguments: { path: "guide.md" },
    ...overrides,
  };
}

function providerProjection(
  tools: readonly { name: string; description: string; parameters: z.ZodTypeAny }[],
): string {
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters, { $refStrategy: "none" }),
    })),
  );
}

describe("MCP gateway tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps provider schemas byte-stable across catalog and handler changes", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = createMcpChatGatewayToolDefinitions({
      reference: async () => ({ type: "mcp_reference_v1", matches: [referenceMatch()] }),
      request: async (request) => ({
        type: "mcp_request_v1",
        serverId: request.serverId,
        status: "denied",
        message: "first",
      }),
      callPolicy: new McpCallPolicy({
        resolveRoute: () => route(),
        invoke: async () => ({ ok: true, result: { content: [] } }),
      }),
    });
    const second = createMcpChatGatewayToolDefinitions({
      reference: async () => ({
        type: "mcp_reference_v1",
        matches: [referenceMatch({ catalogRevision: "catalog-2" })],
      }),
      request: async (request) => ({
        type: "mcp_request_v1",
        serverId: request.serverId,
        status: "denied",
        message: "second",
      }),
      callPolicy: new McpCallPolicy({
        resolveRoute: () => route({ catalogRevision: "catalog-2" }),
        invoke: async () => ({
          ok: true,
          result: { content: [{ type: "text", text: "changed" }] },
        }),
      }),
    });

    const firstProjection = providerProjection(first);
    expect(firstProjection).toBe(providerProjection(second));
    expect(warning).not.toHaveBeenCalled();
    const projectedTools = JSON.parse(firstProjection) as Array<{
      name: string;
      parameters: { properties?: Record<string, unknown> };
    }>;
    expect(
      projectedTools.find((tool) => tool.name === "mcp_call")?.parameters.properties?.arguments,
    ).toEqual({ type: "object", additionalProperties: {} });
    expect(first.map((tool) => tool.name)).toEqual(["mcp_reference", "mcp_request", "mcp_call"]);
  });

  it("rejects stale revisions before native I/O", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { content: [] } }));
    const policy = new McpCallPolicy({ resolveRoute: () => route(), invoke });

    const result = await policy.execute(input({ catalogRevision: "old" }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "catalog_changed",
      currentCatalogRevision: "catalog-1",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not trust a route resolved for a different structured identity", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { content: [] } }));
    const policy = new McpCallPolicy({
      resolveRoute: () => route({ identity: { serverId: "other", nativeToolName: "dangerous" } }),
      invoke,
    });

    const result = await policy.execute(input());

    expect(result).toMatchObject({ status: "rejected", code: "tool_unavailable" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns native JSON Schema issues before native I/O", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, result: { content: [] } }));
    const policy = new McpCallPolicy({ resolveRoute: () => route(), invoke });

    const result = await policy.execute(input({ arguments: { path: "x", extra: true } }));

    expect(result).toMatchObject({ status: "rejected", code: "invalid_arguments" });
    if (result.status === "rejected") {
      expect(result.issues?.map((issue) => issue.keyword)).toEqual(
        expect.arrayContaining(["additionalProperties", "minLength"]),
      );
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("normalizes an authorized native result", async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      result: {
        content: [{ type: "text", text: "done" }],
        structuredContent: { path: "guide.md" },
      },
    }));
    const policy = new McpCallPolicy({ resolveRoute: () => route(), invoke });

    const result = await policy.execute(input());

    expect(result).toEqual({
      type: "mcp_call_result_v1",
      status: "completed",
      tool: { serverId: "docs", nativeToolName: "read" },
      catalogRevision: "catalog-1",
      result: {
        content: [{ type: "text", text: "done" }],
        isError: false,
        structuredContent: { path: "guide.md" },
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
