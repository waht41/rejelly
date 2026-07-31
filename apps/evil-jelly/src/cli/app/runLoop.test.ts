import type { AgentSnapshot, Message, ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestNewSession,
  requestResume,
  takePendingNewSession,
  takePendingResume,
} from "../../services/session/resumeControl";
import * as sessionStore from "../../services/session/sessionStore";
import type { EvilJellyHostBindings } from "../../shared/types";
import { runEvilJellyHost } from "./host/runHost";
import { runInteractiveLoop } from "./runLoop";

vi.mock("./host/runHost", () => ({
  runEvilJellyHost: vi.fn(),
}));

vi.mock("../../tools/mcpServerKit", () => ({
  connectMcpProviders: vi.fn(async () => ({
    providers: {},
    dispose: vi.fn(async () => undefined),
  })),
}));

const runHostMock = vi.mocked(runEvilJellyHost);

function drainSessionSwitches(): void {
  takePendingNewSession();
  takePendingResume();
}

function createBindings() {
  const systemEvents: string[] = [];
  const bindings: EvilJellyHostBindings = {
    getInput: async () => ({ text: "", attachments: [] }),
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
    drainSessionSwitches();
  });

  it("does not pass a durable session id in isolated mock replay segments", async () => {
    const { bindings, systemEvents } = createBindings();
    runHostMock
      .mockImplementationOnce(async () => {
        requestNewSession();
      })
      .mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
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
      mockSourceTraceId: "trace_mock",
      isolateSessionState: true,
    });
    expect(runHostMock.mock.calls[1]?.[1]).toMatchObject({
      sessionId: undefined,
      mockSourceTraceId: "trace_mock",
      isolateSessionState: true,
    });
    expect(systemEvents).toContain("Started new isolated mock session.\n");
  });

  it("does not load durable sessions when a resume request leaks into isolated mock replay", async () => {
    const { bindings, systemEvents } = createBindings();
    const loadSessionSpy = vi.spyOn(sessionStore, "loadSession");
    runHostMock.mockImplementationOnce(async () => {
      requestResume("session_real");
    });

    await runInteractiveLoop({
      bindings,
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
        requestNewSession();
      })
      .mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
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
      seedContext: activeContext,
      seedBudget: budget,
    });
    expect(runHostMock.mock.calls[0]?.[1].snapshot).toBeDefined();
    expect(runHostMock.mock.calls[1]?.[1].sessionId).not.toBe("session_old");
    expect(runHostMock.mock.calls[1]?.[1]).toMatchObject({
      seedContext: undefined,
      seedBudget: undefined,
      snapshot: undefined,
    });
  });

  it("switches context, budget, snapshot, and transcript together on resume", async () => {
    const { bindings } = createBindings();
    const hydrated: Parameters<NonNullable<EvilJellyHostBindings["hydrateHistory"]>>[0][] = [];
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
    vi.spyOn(sessionStore, "loadSession").mockReturnValue({
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
        requestResume("session_target");
      })
      .mockResolvedValueOnce(undefined);

    await runInteractiveLoop({
      bindings,
      model: {} as ModelAdapter,
      enableReview: false,
      snapshot: {} as AgentSnapshot,
      sessionId: "session_current",
    });

    expect(runHostMock).toHaveBeenCalledTimes(2);
    expect(runHostMock.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "session_target",
      seedContext: messages,
      seedBudget: budget,
      snapshot: undefined,
    });
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.map((item) => item.type)).toEqual(["user", "assistant"]);
  });
});
