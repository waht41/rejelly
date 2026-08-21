import { describe, expect, it, vi } from "vitest";
import { createSessionMcpState } from "../../../shared/model/mcp/sessionMcpState";
import { mcpBoundRouteFixture, mcpSessionControlStub } from "../__tests__/mcpTestFixtures";
import type { McpCallAuthorizationHandler, McpGatewayDispatch } from "../gateway/dispatch";
import { createAuthorizedMcpBindingFactory } from "./chatAuthorization";

function unavailableDispatch(): McpGatewayDispatch {
  return {
    binding: { bindingId: "test", generation: 1, servers: [], route: () => undefined },
    reference: async () => ({ type: "mcp_reference_v1", matchedCount: 0, matches: [] }),
    request: async (input) => ({
      type: "mcp_request_v1",
      serverId: input.serverId,
      status: "unavailable",
      code: "runtime_unavailable",
      message: "test",
    }),
    invoke: async () => ({ ok: false, code: "tool_unavailable", message: "test" }),
  };
}

describe("MCP chat authorization", () => {
  it("commits one Session tool grant through the aggregate state port", async () => {
    let state = createSessionMcpState();
    let authorize: McpCallAuthorizationHandler | undefined;
    const commitToolGrants = vi.fn(async (next) => {
      state = next;
    });
    const confirmTool = vi.fn(async () => ({
      action: "accept" as const,
      scope: "session" as const,
    }));
    const factory = createAuthorizedMcpBindingFactory({
      bindingFactory: async (_selected, handler) => {
        authorize = handler;
        return unavailableDispatch();
      },
      control: mcpSessionControlStub({ isToolAutoApproved: () => true }),
      confirmTool,
      state: {
        get: () => state,
        commitSelection: vi.fn(async () => undefined),
        commitToolGrants,
      },
      effectiveSelectedServerIds: () => [],
    });

    await factory();
    expect(await authorize?.(mcpBoundRouteFixture(), { path: "README.md" })).toBe(true);
    expect(confirmTool).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcp_call", autoApprovedByPolicy: true }),
    );
    expect(commitToolGrants).toHaveBeenCalledOnce();
    expect(state.toolGrants).toEqual([
      expect.objectContaining({ serverId: "docs", nativeToolName: "read" }),
    ]);
  });

  it("commits a granted server request through the same Session state port", async () => {
    let state = createSessionMcpState();
    const commitSelection = vi.fn(async (next) => {
      state = next;
    });
    const control = mcpSessionControlStub({
      status: (selectedServerIds) => [
        {
          serverId: "docs",
          source: { kind: "user" },
          exposure: "explicit",
          selected: selectedServerIds.includes("docs"),
          persistentAccess: false,
          routable: selectedServerIds.includes("docs"),
          connection: "ready",
          toolCount: 1,
          configFingerprint: "config-v1",
        },
      ],
    });
    const factory = createAuthorizedMcpBindingFactory({
      bindingFactory: async () => unavailableDispatch(),
      control,
      confirmTool: vi.fn(async () => ({ action: "accept" as const, scope: "session" as const })),
      state: {
        get: () => state,
        commitSelection,
        commitToolGrants: vi.fn(async () => undefined),
      },
      effectiveSelectedServerIds: () => [],
    });

    const dispatch = await factory();
    expect(await dispatch.request({ serverId: "docs" })).toMatchObject({ status: "granted" });
    expect(commitSelection).toHaveBeenCalledOnce();
    expect(state.selectedServerIds).toEqual(["docs"]);
  });
});
