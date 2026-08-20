import { describe, expect, it, vi } from "vitest";
import type { ToolConfirmationHandler } from "../../shared/host/toolConfirmationBindings";
import type { McpBoundRoute, McpDispatchBinding } from "./contracts";
import { createMcpDispatchBindingFactory } from "./mcpServerKit";
import type { McpRuntimeManager } from "./runtime/runtimeManager";

const route: McpBoundRoute = {
  identity: { serverId: "docs", nativeToolName: "read" },
  description: "Read docs",
  inputSchema: { type: "object" },
  configFingerprint: "config-1",
  catalogRevision: "catalog-1",
};

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
    const manager = {
      captureDispatchBinding,
      callBoundTool,
      waitForRequiredServers,
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
    expect(captureDispatchBinding).toHaveBeenNthCalledWith(2, "chat", ["github", "docs"]);
    expect(waitForRequiredServers).toHaveBeenNthCalledWith(1, "chat", ["docs"]);
    expect(waitForRequiredServers).toHaveBeenNthCalledWith(2, "chat", ["github", "docs"]);
  });

  it("rejects a dispatch when a required server finishes unavailable", async () => {
    const manager = {
      waitForRequiredServers: vi.fn(async () => [
        {
          serverId: "docs",
          status: "failed",
          configFingerprint: "config-1",
          error: "offline",
        },
      ]),
      captureDispatchBinding: vi.fn(),
    } as unknown as McpRuntimeManager;

    await expect(createMcpDispatchBindingFactory(manager, vi.fn())(["docs"])).rejects.toThrow(
      "docs (failed: offline)",
    );
    expect(manager.captureDispatchBinding).not.toHaveBeenCalled();
  });
});
