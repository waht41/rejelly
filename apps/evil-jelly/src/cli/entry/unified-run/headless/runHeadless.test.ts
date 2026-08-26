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
