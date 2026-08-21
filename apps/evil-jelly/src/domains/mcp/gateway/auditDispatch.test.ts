import { describe, expect, it, vi } from "vitest";
import type { McpDispatchBinding } from "../contracts";
import type { McpRuntimeManager } from "../runtime/runtimeManager";
import { createAuditMcpDispatch, McpAuditProvenanceCollector } from "./auditDispatch";

const route = {
  identity: { serverId: "docs", nativeToolName: "read" },
  description: "Read docs",
  inputSchema: { type: "object" } as const,
  configFingerprint: "config-1",
  catalogRevision: "catalog-1",
};

const binding: McpDispatchBinding = {
  bindingId: "audit-1",
  generation: 1,
  servers: [],
  route: () => route,
};

describe("Audit MCP dispatch", () => {
  it("shares runtime I/O while enforcing an isolated per-seed call budget", async () => {
    const callBoundTool = vi.fn(async () => ({ ok: true as const, result: { text: "ok" } }));
    const manager = {
      captureDispatchBinding: vi.fn(() => binding),
      getAuditLimits: () => ({ maxCallsPerSeed: 1, maxResultBytesPerSeed: 100 }),
      callBoundTool,
    } as unknown as McpRuntimeManager;
    const provenance = new McpAuditProvenanceCollector();
    const dispatch = createAuditMcpDispatch(manager, provenance);

    await expect(dispatch.invoke(route, {})).resolves.toMatchObject({ ok: true });
    await expect(dispatch.invoke(route, {})).resolves.toMatchObject({
      ok: false,
      code: "call_budget_exceeded",
    });
    expect(callBoundTool).toHaveBeenCalledOnce();
    expect(provenance.snapshot()).toEqual([
      { serverId: "docs", configFingerprint: "config-1", catalogRevision: "catalog-1" },
    ]);
  });

  it("does not admit an oversized native result into the evaluator context", async () => {
    const manager = {
      captureDispatchBinding: () => binding,
      getAuditLimits: () => ({ maxCallsPerSeed: 2, maxResultBytesPerSeed: 4 }),
      callBoundTool: vi.fn(async () => ({ ok: true as const, result: { text: "too large" } })),
    } as unknown as McpRuntimeManager;

    await expect(
      createAuditMcpDispatch(manager, new McpAuditProvenanceCollector()).invoke(route, {}),
    ).resolves.toMatchObject({ ok: false, code: "result_too_large" });
  });
});
