import type { AgentSnapshot, Message, ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectMcpProviders } from "../../../../domains/mcp/mcpServerKit";
import * as sessionStore from "../../../../domains/session/repository/sessionStore";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { textPromptInput } from "../../../../shared/model/prompt/promptInput";
import { createInteractiveRunControl, type InteractiveRunControl } from "./runControl";
import { runInteractiveLoop } from "./runLoop";
import { runEvilJellyHost } from "./runSegment";

const runtimeMocks = vi.hoisted(() => ({
  buildSkillRuntime: vi.fn(),
  formatSkillSummary: vi.fn(),
  disposeMcp: vi.fn(async () => undefined),
}));

vi.mock("./runSegment", () => ({
  runEvilJellyHost: vi.fn(),
}));

vi.mock("../../../../domains/mcp/mcpServerKit", () => ({
  connectMcpProviders: vi.fn(async () => ({
    providers: {},
    dispose: runtimeMocks.disposeMcp,
  })),
}));

vi.mock("../../../../shared/configuration/settings", () => ({
  getSettings: () => ({ devtoolMcp: true }),
}));

vi.mock("../../../skill-runtime/configuredRuntime", () => ({
  buildConfiguredSkillRuntimeSnapshot: runtimeMocks.buildSkillRuntime,
}));

vi.mock("../../../skill-runtime/startupSummary", () => ({
  formatSkillRuntimeStartupSummary: runtimeMocks.formatSkillSummary,
}));

const runHostMock = vi.mocked(runEvilJellyHost);
const connectMcpProvidersMock = vi.mocked(connectMcpProviders);
let runControl: InteractiveRunControl;

function createBindings() {
  const systemEvents: string[] = [];
  const bindings: EvilJellyBindings = {
    getInput: async () => textPromptInput(""),
    printOut: () => {},
    logUserMessage: () => {},
    logAssistantMessage: () => {},
    logSystemEvent: (message) => systemEvents.push(message),
    logToolBlock: () => {},
    confirmTool: async () => ({ ok: false, action: "reject" }),
    requestChoice: async () => "",
  };
  return { bindings, systemEvents };
}

describe("runInteractiveLoop mock session isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runControl = createInteractiveRunControl();
    runtimeMocks.buildSkillRuntime.mockResolvedValue({
      snapshot: { catalog: { size: 0, hash: "00000000" } },
      diagnostics: [],
    });
    runtimeMocks.formatSkillSummary.mockReturnValue(undefined);
  });

  it("passes the resolved devtool opt-in to the MCP connection boundary", async () => {
    const { bindings } = createBindings();
    runHostMock.mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
      runControl,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: undefined,
      isolateSessionState: true,
    });

    expect(connectMcpProvidersMock).toHaveBeenCalledWith({ devtoolMcp: true });
  });

  it("publishes the path-free enabled Skill catalog through the host boundary", async () => {
    const { bindings } = createBindings();
    const setAvailableSkills = vi.fn();
    bindings.setAvailableSkills = setAvailableSkills;
    runtimeMocks.buildSkillRuntime.mockResolvedValueOnce({
      snapshot: {
        catalog: {
          size: 1,
          fingerprint: "12345678",
          entries: [
            {
              name: "review",
              description: "Review changes",
              shortDescription: "Review",
              origin: { scope: "project" },
              instruction: "Review carefully.",
              resources: [],
            },
          ],
        },
      },
      diagnostics: [],
    });
    runHostMock.mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
      runControl,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: undefined,
      isolateSessionState: true,
    });

    expect(setAvailableSkills).toHaveBeenCalledWith([
      {
        name: "review",
        qualifiedName: "project:review",
        scope: "project",
        description: "Review changes",
        shortDescription: "Review",
      },
    ]);
  });

  it("does not pass a durable session id in isolated mock replay segments", async () => {
    const { bindings, systemEvents } = createBindings();
    runtimeMocks.formatSkillSummary.mockReturnValueOnce("Loaded 1 local Skill.");
    runHostMock
      .mockImplementationOnce(async () => {
        runControl.loop.request({ type: "new_session" });
      })
      .mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
      runControl,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: undefined,
      sessionId: "session_real",
      seedHistory: undefined,
      seedBudget: undefined,
      mockSourceTraceId: "trace_mock",
      isolateSessionState: true,
    });

    expect(runHostMock).toHaveBeenCalledTimes(2);
    expect(runHostMock.mock.calls[0]?.[1]).toMatchObject({
      sessionId: undefined,
      sessionStartMode: "new",
      mockSourceTraceId: "trace_mock",
      isolateSessionState: true,
    });
    expect(runHostMock.mock.calls[1]?.[1]).toMatchObject({
      sessionId: undefined,
      sessionStartMode: "new",
      mockSourceTraceId: "trace_mock",
      isolateSessionState: true,
    });
    expect(runtimeMocks.buildSkillRuntime).toHaveBeenCalledOnce();
    expect(runHostMock.mock.calls[0]?.[1].skillSnapshot).toBe(
      runHostMock.mock.calls[1]?.[1].skillSnapshot,
    );
    expect(systemEvents).toContain("Started new isolated mock session.\n");
    expect(systemEvents.filter((event) => event === "Loaded 1 local Skill.\n")).toHaveLength(1);
  });

  it("does not load durable sessions when a resume request leaks into isolated mock replay", async () => {
    const { bindings, systemEvents } = createBindings();
    const loadSessionSpy = vi.spyOn(sessionStore, "resumeSession");
    runHostMock.mockImplementationOnce(async () => {
      runControl.loop.request({ type: "resume", sessionId: "session_real" });
    });

    await runInteractiveLoop({
      bindings,
      runControl,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: undefined,
      sessionId: "session_mock",
      seedHistory: undefined,
      seedBudget: undefined,
      mockSourceTraceId: "trace_mock",
      isolateSessionState: true,
    });

    expect(loadSessionSpy).not.toHaveBeenCalled();
    expect(systemEvents).toContain("Resume is disabled during mock replay.\n");
  });

  it("clears the complete resume seed and startup snapshot when starting a new session", async () => {
    const { bindings } = createBindings();
    const activeContext: Message[] = [{ role: "user", content: "old task" }];
    const budget = {
      totalTokens: 10,
      promptTokens: 7,
      completionTokens: 3,
      cacheReadTokens: 0,
      callCount: 1,
      costs: {},
      lastContextTokens: 7,
      lastCacheReadTokens: 0,
    };
    runHostMock
      .mockImplementationOnce(async () => {
        runControl.loop.request({ type: "new_session" });
      })
      .mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
      runControl,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: {} as AgentSnapshot,
      sessionId: "session_old",
      resumeSeed: {
        activeContext,
        transcript: [],
        totalTurns: 1,
        budget,
      },
    });

    expect(runHostMock).toHaveBeenCalledTimes(2);
    expect(runHostMock.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "session_old",
      sessionStartMode: "resumed",
      seedContext: activeContext,
      seedBudget: budget,
    });
    expect(runHostMock.mock.calls[0]?.[1].snapshot).toBeDefined();
    expect(runHostMock.mock.calls[1]?.[1].sessionId).not.toBe("session_old");
    expect(runHostMock.mock.calls[1]?.[1]).toMatchObject({
      sessionStartMode: "new",
      seedContext: undefined,
      seedBudget: undefined,
      snapshot: undefined,
    });
  });

  it("switches context, budget, snapshot, and transcript together on resume", async () => {
    const { bindings } = createBindings();
    const hydrated: Parameters<NonNullable<EvilJellyBindings["hydrateHistory"]>>[0][] = [];
    bindings.hydrateHistory = (items) => hydrated.push(items);
    const messages: Message[] = [
      { role: "user", content: "resumed task" },
      { role: "assistant", content: '{"reply":"resumed answer"}' },
    ];
    const budget = {
      totalTokens: 20,
      promptTokens: 15,
      completionTokens: 5,
      cacheReadTokens: 0,
      callCount: 2,
      costs: {},
      lastContextTokens: 10,
      lastCacheReadTokens: 0,
    };
    vi.spyOn(sessionStore, "resumeSession").mockResolvedValue({
      meta: {
        id: "session_target",
        workspaceRoot: "workspace",
        title: "resumed task",
        createdAt: 1,
        updatedAt: 2,
        turns: 1,
        traceIds: [],
        budget,
      },
      messages,
    });
    runHostMock
      .mockImplementationOnce(async () => {
        runControl.loop.request({ type: "resume", sessionId: "session_target" });
      })
      .mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
      runControl,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: {} as AgentSnapshot,
      sessionId: "session_current",
      sessionV2: { enabled: true, appVersion: "1.0.0" },
    });

    expect(runHostMock).toHaveBeenCalledTimes(2);
    expect(runHostMock.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "session_target",
      sessionStartMode: "resumed",
      seedContext: messages,
      seedBudget: budget,
      snapshot: undefined,
      sessionV2: { enabled: true, appVersion: "1.0.0" },
    });
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.map((item) => item.type)).toEqual(["user", "assistant"]);
  });

  it("disposes connected MCP clients when configured Skill startup unexpectedly fails", async () => {
    const { bindings } = createBindings();
    runtimeMocks.buildSkillRuntime.mockRejectedValueOnce(new Error("skill startup failed"));

    await expect(
      runInteractiveLoop({
        bindings,
        runControl,
        model: {} as ModelAdapter,
        enableReview: false,
        snapshot: undefined,
      }),
    ).rejects.toThrow("skill startup failed");

    expect(runHostMock).not.toHaveBeenCalled();
    expect(runtimeMocks.disposeMcp).toHaveBeenCalledOnce();
  });
});
