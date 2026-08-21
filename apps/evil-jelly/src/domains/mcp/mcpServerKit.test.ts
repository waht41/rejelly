import { describe, expect, it, vi } from "vitest";
import type { ToolConfirmationHandler } from "../../shared/host/toolConfirmationBindings";
import { mcpBoundRouteFixture } from "./__tests__/mcpTestFixtures";
import type { McpDispatchBinding } from "./contracts";
import { createMcpDispatchBindingFactory } from "./mcpServerKit";
import type { McpRuntimeManager } from "./runtime/runtimeManager";

const route = mcpBoundRouteFixture({
  configFingerprint: "config-1",
  catalogRevision: "catalog-1",
});

function binding(id: string): McpDispatchBinding {
  return {
    bindingId: id,
    generation: 1,
    servers: [],
    route: () => route,
  };
}

describe("MCP dispatch composition", () => {
  it("captures each boundary independently and blocks denied calls before runtime I/O", async () => {
    const captureDispatchBinding = vi
      .fn()
      .mockReturnValueOnce(binding("first"))
      .mockReturnValueOnce(binding("second"));
    const callBoundTool = vi.fn(async () => ({
      ok: true as const,
      result: { content: [{ type: "text", text: "ok" }] },
    }));
    const waitForRequiredServers = vi.fn(async () => []);
    const activateServers = vi.fn(async () => undefined);
    const manager = {
      captureDispatchBinding,
      callBoundTool,
      waitForRequiredServers,
      activateServers,
    } as unknown as McpRuntimeManager;
    const confirmTool = vi
      .fn<ToolConfirmationHandler>()
      .mockResolvedValueOnce({ action: "reject" })
      .mockResolvedValueOnce({ action: "accept" });
    const factory = createMcpDispatchBindingFactory(manager, confirmTool);

    const first = await factory(["docs"]);
    const second = await factory(["github", "docs"]);
    await expect(first.invoke(route, {})).resolves.toMatchObject({
      ok: false,
      code: "approval_denied",
    });
    expect(callBoundTool).not.toHaveBeenCalled();

    await expect(second.invoke(route, { path: "guide.md" })).resolves.toMatchObject({ ok: true });
    expect(callBoundTool).toHaveBeenCalledWith("chat", route, { path: "guide.md" });
    expect(captureDispatchBinding).toHaveBeenCalledTimes(2);
    expect(captureDispatchBinding).toHaveBeenNthCalledWith(1, "chat", ["docs"]);
    expect(captureDispatchBinding).toHaveBeenNthCalledWith(2, "chat", ["docs", "github"]);
    expect(waitForRequiredServers).toHaveBeenNthCalledWith(1, "chat", ["docs"]);
    expect(waitForRequiredServers).toHaveBeenNthCalledWith(2, "chat", ["docs", "github"]);
    expect(activateServers).toHaveBeenNthCalledWith(1, "chat", ["docs"]);
    expect(activateServers).toHaveBeenNthCalledWith(2, "chat", ["docs", "github"]);
  });

  it("rejects a dispatch when a required server finishes unavailable", async () => {
    const manager = {
      activateServers: vi.fn(async () => undefined),
      waitForRequiredServers: vi.fn(async () => [
        {
          serverId: "docs",
          status: "failed",
          configFingerprint: "config-1",
          failure: {
            code: "runtime_error",
            messageExcerpt: "offline",
            messageTruncated: false,
          },
        },
      ]),
      captureDispatchBinding: vi.fn(),
    } as unknown as McpRuntimeManager;

    await expect(createMcpDispatchBindingFactory(manager, vi.fn())(["docs"])).rejects.toThrow(
      "docs (failed: offline)",
    );
    expect(manager.captureDispatchBinding).not.toHaveBeenCalled();
  });

  it("adds persistently authorized servers to every captured chat binding", async () => {
    const manager = {
      activateServers: vi.fn(async () => undefined),
      waitForRequiredServers: vi.fn(async () => []),
      captureDispatchBinding: vi.fn(() => binding("persistent")),
    } as unknown as McpRuntimeManager;
    const factory = createMcpDispatchBindingFactory(manager, vi.fn(), {
      persistentServerIds: () => ["docs"],
    });

    await factory(["github"]);

    expect(manager.waitForRequiredServers).toHaveBeenCalledWith("chat", ["docs", "github"]);
    expect(manager.captureDispatchBinding).toHaveBeenCalledWith("chat", ["docs", "github"]);
  });

  it("waits before reference and reads the catalog from a fresh binding", async () => {
    const pending = binding("pending");
    const ready: McpDispatchBinding = {
      bindingId: "ready",
      generation: 2,
      servers: [
        {
          serverId: "docs",
          configFingerprint: "config-1",
          status: "ready",
          catalogRevision: "catalog-1",
          tools: [
            {
              nativeToolName: "read",
              description: "Read docs",
              inputSchema: { type: "object" },
            },
          ],
        },
      ],
      route: () => route,
    };
    const waitForReferenceServers = vi.fn(async () => []);
    const manager = {
      activateServers: vi.fn(async () => undefined),
      waitForRequiredServers: vi.fn(async () => []),
      waitForReferenceServers,
      captureDispatchBinding: vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(ready),
    } as unknown as McpRuntimeManager;
    const dispatch = await createMcpDispatchBindingFactory(manager, vi.fn())(["docs"]);

    await expect(dispatch.reference({ query: "*", serverIds: ["docs"] })).resolves.toMatchObject({
      matches: [
        expect.objectContaining({ identity: { serverId: "docs", nativeToolName: "read" } }),
      ],
    });
    expect(waitForReferenceServers).toHaveBeenCalledWith("chat", ["docs"], ["docs"], {
      onWaitStart: undefined,
    });
  });
});
