import type { ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SkillRuntimeSnapshot, skillOrigin } from "../../../features/skills/contracts";
import { createSkillCatalog } from "../../../features/skills/skillCatalog";
import { requestRunAbort } from "../../../shared/runtime/runControl";
import type { EvilJellyHostBindings } from "../../../shared/types";
import { runDirectUnified, runEvilJellyHost } from "./runHost";

const mocks = vi.hoisted(() => ({
  mainCliAgent: vi.fn(),
  openSessionRecorder: vi.fn(),
  runWithReview: vi.fn(),
  buildSkillRuntime: vi.fn(),
  formatSkillSummary: vi.fn(),
}));

vi.mock("../orchestration/MainCliAgent", () => ({
  MainCliAgent: mocks.mainCliAgent,
}));

vi.mock("../../../services/session/sessionRecorder", () => ({
  openSessionRecorder: mocks.openSessionRecorder,
}));

vi.mock("../../../shared/fs-policy/workspace-fs-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/fs-policy/workspace-fs-policy")>()),
  getWorkspaceFsPolicy: () => ({ getRoot: () => "/workspace" }),
}));

vi.mock("../../../shared/lib/traceId", () => ({
  generateTraceId: () => "trace-id",
}));

vi.mock("../../../features/skills/skillRuntimeSnapshot", () => ({
  buildConfiguredSkillRuntimeSnapshot: mocks.buildSkillRuntime,
  formatSkillRuntimeStartupSummary: mocks.formatSkillSummary,
}));

vi.mock("./runWithReview", () => ({
  runWithReview: mocks.runWithReview,
}));

describe("runEvilJellyHost session teardown", () => {
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
      resources: Object.freeze({
        readText: async () => ({
          ok: false as const,
          reason: "resource-not-listed" as const,
          message: "not listed",
        }),
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildSkillRuntime.mockResolvedValue({
      snapshot: skillSnapshot(),
      diagnostics: [],
    });
    mocks.formatSkillSummary.mockReturnValue("Loaded 1 local Skill.");
  });

  it("ends an idle Ctrl+C run as interrupted before closing the writer", async () => {
    const endSegment = vi.fn();
    const close = vi.fn();
    mocks.openSessionRecorder.mockResolvedValue({
      ended: false,
      endSegment,
      close,
    });
    mocks.mainCliAgent.mockReturnValue(new Promise(() => undefined));
    mocks.runWithReview.mockImplementation(
      async (options: { run: () => Promise<unknown>; runWithOptions: { signal: AbortSignal } }) => {
        const running = options.run();
        const aborted = new Promise<never>((_resolve, reject) => {
          options.runWithOptions.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Stopped by user (Ctrl+C)");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        queueMicrotask(() => requestRunAbort("Stopped by user (Ctrl+C)"));
        return Promise.race([running, aborted]);
      },
    );

    const logSystemEvent = vi.fn();
    await runEvilJellyHost({ logSystemEvent } as unknown as EvilJellyHostBindings, {
      model: { id: "test-model" } as ModelAdapter,
      sessionId: "idle-session",
      sessionStartMode: "resumed",
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot: "/sessions" },
    });

    expect(endSegment).toHaveBeenCalledOnce();
    expect(endSegment).toHaveBeenCalledWith({
      status: "interrupted",
      reason: "abort",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(endSegment.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    expect(logSystemEvent).toHaveBeenCalledWith("\nRun interrupted by user.\n");
  });

  it("does not open a recorder when a new untouched session is interrupted while idle", async () => {
    mocks.mainCliAgent.mockReturnValue(new Promise(() => undefined));
    mocks.runWithReview.mockImplementation(
      async (options: { run: () => Promise<unknown>; runWithOptions: { signal: AbortSignal } }) => {
        const running = options.run();
        const aborted = new Promise<never>((_resolve, reject) => {
          options.runWithOptions.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Stopped by user (Ctrl+C)");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        queueMicrotask(() => requestRunAbort("Stopped by user (Ctrl+C)"));
        return Promise.race([running, aborted]);
      },
    );

    const logSystemEvent = vi.fn();
    await runEvilJellyHost({ logSystemEvent } as unknown as EvilJellyHostBindings, {
      model: { id: "test-model" } as ModelAdapter,
      sessionId: "new-idle-session",
      sessionStartMode: "new",
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot: "/sessions" },
    });

    expect(mocks.openSessionRecorder).not.toHaveBeenCalled();
    expect(logSystemEvent).toHaveBeenCalledWith("\nRun interrupted by user.\n");
  });

  it("seeds the borrowed Skill provider and trace identity beside MCP providers", async () => {
    const snapshot = skillSnapshot();
    mocks.runWithReview.mockResolvedValue(undefined);

    await runEvilJellyHost({ logSystemEvent: vi.fn() } as unknown as EvilJellyHostBindings, {
      model: { id: "test-model" } as ModelAdapter,
      mcpProviders: { "mcp:devtool": { id: "client" } },
      skillSnapshot: snapshot,
    });

    const runWithOptions = mocks.runWithReview.mock.calls[0]?.[0].runWithOptions;
    expect(runWithOptions.providers).toMatchObject({
      "mcp:devtool": { id: "client" },
      "evil-jelly:skill-runtime:v1": snapshot,
    });
    expect(runWithOptions.trace.attributes).toMatchObject({
      "evil_jelly.skills.count": 1,
      "evil_jelly.skills.catalog_fingerprint": snapshot.catalog.fingerprint,
    });
  });

  it("uses the same configured snapshot builder for direct headless UnifiedAgent runs", async () => {
    mocks.runWithReview.mockResolvedValue(undefined);
    const prepared = { snapshot: skillSnapshot(), diagnostics: [] };
    mocks.buildSkillRuntime.mockResolvedValue(prepared);
    const logSystemEvent = vi.fn();

    await runDirectUnified({ logSystemEvent } as unknown as EvilJellyHostBindings, {
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
