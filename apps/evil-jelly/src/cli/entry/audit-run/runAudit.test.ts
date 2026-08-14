import type { ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { runAudit } from "./runAudit";

const mocks = vi.hoisted(() => ({
  auditAgent: vi.fn(),
  loadDocMap: vi.fn(),
  runWithReview: vi.fn(),
  setBinding: vi.fn(),
}));

vi.mock("../../../features/audit/AuditAgent", () => ({
  AuditAgent: { fork: () => mocks.auditAgent },
}));
vi.mock("../../../features/audit/detectors/docDrift", () => ({
  docMapPath: () => "/workspace/.evil-jelly/doc-map.jsonc",
  loadDocMap: mocks.loadDocMap,
}));
vi.mock("../../../shared/host/context", () => ({ setBinding: mocks.setBinding }));
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
    expect(mocks.runWithReview).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        enableReview: true,
        runWithOptions: {
          trace: {
            traceId: "audit-trace",
            attributes: { "devtool.display_name": "evil-jelly audit" },
          },
        },
      }),
    );
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
