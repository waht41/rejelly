import type { ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRuntimeSnapshot } from "../../../../domains/skills/agent/skillRuntime";
import { createSkillCatalog } from "../../../../domains/skills/catalog/skillCatalog";
import { skillOrigin } from "../../../../domains/skills/definition/skillDefinition";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { runHeadless } from "./runHeadless";

const mocks = vi.hoisted(() => ({
  runWithReview: vi.fn(),
  buildSkillRuntime: vi.fn(),
  formatSkillSummary: vi.fn(),
  openSessionRecorder: vi.fn(),
  observeSessionRecorder: vi.fn(),
}));

vi.mock("../../../../domains/session/repository/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../domains/session/repository/sessionStore")>()),
  generateSessionId: () => "session-id",
}));
vi.mock("../../../../domains/session/recorder/sessionRecorder", () => ({
  openSessionRecorder: mocks.openSessionRecorder,
}));
vi.mock("../../../../domains/session/recorder/sessionObservationRecorder", () => ({
  observeSessionRecorder: mocks.observeSessionRecorder,
}));
vi.mock("../../../runtime/traceId", () => ({ generateTraceId: () => "trace-id" }));
vi.mock("../../../skill-runtime/configuredRuntime", () => ({
  buildConfiguredSkillRuntimeSnapshot: mocks.buildSkillRuntime,
}));

vi.mock("../../../skill-runtime/startupSummary", () => ({
  formatSkillRuntimeStartupSummary: mocks.formatSkillSummary,
}));
vi.mock("../../../runtime/runWithReview", () => ({ runWithReview: mocks.runWithReview }));

function skillSnapshot(): SkillRuntimeSnapshot {
  return Object.freeze({
    catalog: createSkillCatalog([
      Object.freeze({
        name: "review",
        description: "Review",
        instruction: "Review carefully.",
        origin: skillOrigin("project"),
        resources: Object.freeze([]),
      }),
    ]),
    access: Object.freeze({
      get: () =>
        Object.freeze({
          kind: "host-filesystem" as const,
          rootPath: "/skills/project/review",
          mainResource: "SKILL.md" as const,
          pathConvention: "posix" as const,
        }),
    }),
    resources: Object.freeze({
      readText: async () => ({
        ok: false as const,
        reason: "resource-not-listed" as const,
        message: "not listed",
      }),
    }),
  });
}

describe("runHeadless", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.formatSkillSummary.mockReturnValue("Loaded 1 local Skill.");
  });

  it("records headless runs in the selected portable Session store", async () => {
    mocks.runWithReview.mockResolvedValue(undefined);
    mocks.buildSkillRuntime.mockResolvedValue({ snapshot: skillSnapshot(), diagnostics: [] });
    const recorder = {
      ended: false,
      endSegment: vi.fn(),
      close: vi.fn(),
    };
    mocks.openSessionRecorder.mockResolvedValue(recorder);
    mocks.observeSessionRecorder.mockReturnValue(recorder);
    const logSystemEvent = vi.fn();

    await runHeadless({ logSystemEvent } as unknown as EvilJellyBindings, {
      model: { id: "test-model", provider: "openai" } as ModelAdapter,
      userInput: "hello",
      appVersion: "1.2.3",
      sessionStorage: {
        sessionsRoot: "/portable/sessions",
        blobRoot: "/portable/blobs",
      },
    });

    expect(mocks.openSessionRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-id",
        traceId: "trace-id",
        appVersion: "1.2.3",
        modelId: "test-model",
        provider: "openai",
        sessionsRoot: "/portable/sessions",
        blobRoot: "/portable/blobs",
      }),
    );
    expect(logSystemEvent).toHaveBeenCalledWith("[Headless] Session ID: session-id\n");
    expect(recorder.endSegment).toHaveBeenCalledWith({ status: "completed", reason: "exit" });
    expect(recorder.close).toHaveBeenCalledOnce();
    expect(mocks.runWithReview.mock.calls[0]?.[0].runWithOptions.trace.attributes).toMatchObject({
      "evil_jelly.headless": true,
      "session.id": "session-id",
    });
  });

  it("uses the configured Skill snapshot for a direct headless run", async () => {
    mocks.runWithReview.mockResolvedValue(undefined);
    const prepared = { snapshot: skillSnapshot(), diagnostics: [] };
    mocks.buildSkillRuntime.mockResolvedValue(prepared);
    const logSystemEvent = vi.fn();

    await runHeadless({ logSystemEvent } as unknown as EvilJellyBindings, {
      model: { id: "test-model" } as ModelAdapter,
      userInput: "hello",
    });

    expect(mocks.buildSkillRuntime).toHaveBeenCalledOnce();
    expect(logSystemEvent).toHaveBeenCalledWith("Loaded 1 local Skill.\n");
    const runWithOptions = mocks.runWithReview.mock.calls[0]?.[0].runWithOptions;
    expect(runWithOptions.providers["evil-jelly:skill-runtime:v1"]).toBe(prepared.snapshot);
    expect(runWithOptions.trace.attributes).toMatchObject({
      "evil_jelly.headless": true,
      "evil_jelly.skills.count": 1,
    });
  });
});
