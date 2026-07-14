import type { ModelAdapter } from "@rejelly/core";
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
});
