import type { ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { runAudit } from "./runAudit";

const mocks = vi.hoisted(() => ({
  auditAgent: vi.fn(),
  auditServers: [] as unknown[],
  disposeMcp: vi.fn(async () => undefined),
  loadDocMap: vi.fn(),
  reconcileMcp: vi.fn(async () => undefined),
  runWithReview: vi.fn(),
  setBinding: vi.fn(),
  runtimeConstructions: 0,
  waitForRequiredServers: vi.fn(async () => []),
}));

vi.mock("../../../domains/mcp/configuration/configuration", () => ({
  resolveMcpSettingsLayers: () => ({ servers: mocks.auditServers }),
}));
vi.mock("../../../domains/mcp/runtime/runtimeManager", () => ({
  McpRuntimeManager: class {
    constructor() {
      mocks.runtimeConstructions += 1;
    }
    reconcile = mocks.reconcileMcp;
    waitForRequiredServers = mocks.waitForRequiredServers;
    dispose = mocks.disposeMcp;
  },
}));
vi.mock("../../../domains/mcp/runtime/sdkConnector", () => ({
  SdkMcpRuntimeConnector: class {},
}));

vi.mock("../../../features/audit/AuditAgent", () => ({
  AuditAgent: { fork: () => mocks.auditAgent },
}));
vi.mock("../../../features/audit/detectors/docDrift", () => ({
  docMapPath: () => "/workspace/.evil-jelly/doc-map.jsonc",
  loadDocMap: mocks.loadDocMap,
}));
vi.mock("../../../shared/host/context", () => ({ setBinding: mocks.setBinding }));
vi.mock("../../../shared/configuration/settings", () => ({
  getSettings: () => ({ mcp: {} }),
}));
vi.mock("../../../shared/fs-policy/workspace-fs-policy", () => ({
  getWorkspaceFsPolicy: () => ({ getRoot: () => "/workspace" }),
}));
vi.mock("../../../shared/mcp/trustRepository", () => ({ readMcpTrustGrants: () => [] }));
vi.mock("../../runtime/traceId", () => ({ generateTraceId: () => "audit-trace" }));
vi.mock("../../runtime/runWithReview", () => ({ runWithReview: mocks.runWithReview }));

function bindings(): EvilJellyBindings {
  return {
    logUserMessage: vi.fn(),
    logAssistantMessage: vi.fn(),
  } as unknown as EvilJellyBindings;
}

describe("runAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditServers = [];
    mocks.runtimeConstructions = 0;
    mocks.runWithReview.mockImplementation((options: { run: () => Promise<void> }) =>
      options.run(),
    );
    mocks.auditAgent.mockResolvedValue("audit report");
  });

  it("runs one audit family inside the injected execution envelope", async () => {
    const host = bindings();
    const model = { id: "test-model" } as ModelAdapter;

    await runAudit({
      model,
      bindings: host,
      enableReview: true,
      auditOptions: { family: "clone", maxSeeds: 3 },
    });

    expect(mocks.setBinding).toHaveBeenCalledWith(host);
    expect(mocks.auditAgent).toHaveBeenCalledWith({ family: "clone", maxSeeds: 3 });
    expect(host.logAssistantMessage).toHaveBeenCalledWith("audit report");
    expect(mocks.runtimeConstructions).toBe(0);
    const runWithOptions = mocks.runWithReview.mock.calls[0]?.[0].runWithOptions;
    expect(runWithOptions).not.toHaveProperty("providers");
    expect(mocks.runWithReview).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        enableReview: true,
        runWithOptions: expect.objectContaining({
          trace: {
            traceId: "audit-trace",
            attributes: { "devtool.display_name": "evil-jelly audit" },
          },
        }),
      }),
    );
  });

  it("creates and lends one runtime only when Audit MCP servers are configured", async () => {
    mocks.auditServers = [
      {
        id: "docs",
        definition: { use: { audit: { exposure: "always" } } },
      },
    ];

    await runAudit({
      model: { id: "test-model" } as ModelAdapter,
      bindings: bindings(),
      enableReview: false,
      auditOptions: { family: "clone" },
    });

    expect(mocks.runtimeConstructions).toBe(1);
    expect(mocks.reconcileMcp).toHaveBeenCalledOnce();
    expect(mocks.waitForRequiredServers).toHaveBeenCalledWith("audit");
    expect(mocks.runWithReview.mock.calls[0]?.[0].runWithOptions.providers).toMatchObject({
      "mcp:runtime": expect.anything(),
      "mcp:audit-provenance": expect.anything(),
    });
    expect(mocks.disposeMcp).toHaveBeenCalledOnce();
  });

  it("returns the doc-map guidance without invoking the agent when doc-drift has no map", async () => {
    mocks.loadDocMap.mockResolvedValue(null);
    const host = bindings();

    await runAudit({
      model: { id: "test-model" } as ModelAdapter,
      bindings: host,
      enableReview: false,
      auditOptions: { family: "doc-drift" },
    });

    expect(mocks.auditAgent).not.toHaveBeenCalled();
    expect(host.logAssistantMessage).toHaveBeenCalledWith(
      expect.stringContaining("Doc validation needs a doc map"),
    );
  });
});
