import type { ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRuntimeSnapshot } from "../../../../domains/skills/agent/skillRuntime";
import { createSkillCatalog } from "../../../../domains/skills/catalog/skillCatalog";
import { skillOrigin } from "../../../../domains/skills/definition/skillDefinition";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { createInteractiveRunControl } from "./runControl";
import { runEvilJellyHost } from "./runSegment";

const mocks = vi.hoisted(() => ({
  mainCliAgent: vi.fn(),
  openSessionRecorder: vi.fn(),
  runWithReview: vi.fn(),
}));

vi.mock("../../../unified-conversation/MainCliAgent", () => ({
  MainCliAgent: mocks.mainCliAgent,
}));

vi.mock("../../../../domains/session/recorder/sessionRecorder", () => ({
  openSessionRecorder: mocks.openSessionRecorder,
}));

vi.mock("../../../../shared/fs-policy/workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../shared/fs-policy/workspace-context")>()),
  getWorkspaceRoot: () => "/workspace",
}));

vi.mock("../../../runtime/traceId", () => ({
  generateTraceId: () => "trace-id",
}));

vi.mock("../../../runtime/runWithReview", () => ({
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ends an idle Ctrl+C run as interrupted before closing the writer", async () => {
    const runControl = createInteractiveRunControl();
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
        queueMicrotask(() => runControl.segment.requestAbort("Stopped by user (Ctrl+C)"));
        return Promise.race([running, aborted]);
      },
    );

    const logSystemEvent = vi.fn();
    await runEvilJellyHost({ logSystemEvent } as unknown as EvilJellyBindings, {
      runControl,
      model: { id: "test-model" } as ModelAdapter,
      sessionId: "idle-session",
      sessionStartMode: "resumed",
      session: { enabled: true, appVersion: "1.0.0", sessionsRoot: "/sessions" },
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
    const runControl = createInteractiveRunControl();
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
        queueMicrotask(() => runControl.segment.requestAbort("Stopped by user (Ctrl+C)"));
        return Promise.race([running, aborted]);
      },
    );

    const logSystemEvent = vi.fn();
    await runEvilJellyHost({ logSystemEvent } as unknown as EvilJellyBindings, {
      runControl,
      model: { id: "test-model" } as ModelAdapter,
      sessionId: "new-idle-session",
      sessionStartMode: "new",
      session: { enabled: true, appVersion: "1.0.0", sessionsRoot: "/sessions" },
    });

    expect(mocks.openSessionRecorder).not.toHaveBeenCalled();
    expect(logSystemEvent).toHaveBeenCalledWith("\nRun interrupted by user.\n");
  });

  it("seeds the borrowed Skill provider and trace identity beside MCP providers", async () => {
    const snapshot = skillSnapshot();
    mocks.runWithReview.mockResolvedValue(undefined);

    await runEvilJellyHost({ logSystemEvent: vi.fn() } as unknown as EvilJellyBindings, {
      runControl: createInteractiveRunControl(),
      model: { id: "test-model" } as ModelAdapter,
      mcpProviders: { "mcp:runtime": { id: "manager" } },
      skillSnapshot: snapshot,
    });

    const runWithOptions = mocks.runWithReview.mock.calls[0]?.[0].runWithOptions;
    expect(runWithOptions.providers).toMatchObject({
      "mcp:runtime": { id: "manager" },
      "evil-jelly:skill-runtime:v1": snapshot,
    });
    expect(runWithOptions.trace.attributes).toMatchObject({
      "evil_jelly.skills.count": 1,
      "evil_jelly.skills.catalog_fingerprint": snapshot.catalog.fingerprint,
    });
  });
});
