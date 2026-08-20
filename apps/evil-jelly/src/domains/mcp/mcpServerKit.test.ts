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
    const manager = { captureDispatchBinding, callBoundTool } as unknown as McpRuntimeManager;
    const confirmTool = vi
      .fn<ToolConfirmationHandler>()
      .mockResolvedValueOnce({ action: "reject" })
      .mockResolvedValueOnce({ action: "accept" });
    const factory = createMcpDispatchBindingFactory(manager, confirmTool);

    const first = await factory();
    const second = await factory();
    await expect(first.invoke(route, {})).resolves.toMatchObject({
      ok: false,
      code: "approval_denied",
    });
    expect(callBoundTool).not.toHaveBeenCalled();

    await expect(second.invoke(route, { path: "guide.md" })).resolves.toMatchObject({ ok: true });
    expect(callBoundTool).toHaveBeenCalledWith("chat", route, { path: "guide.md" });
    expect(captureDispatchBinding).toHaveBeenCalledTimes(2);
  });
});
