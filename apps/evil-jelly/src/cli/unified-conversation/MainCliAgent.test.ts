import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../../domains/session/repository/sessionStore";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import type { PromptChoiceRequest } from "../../shared/host/inputBindings";
import { createInteractiveRunControl } from "../entry/unified-run/interactive/runControl";
import { tryRequestResume } from "./MainCliAgent";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  loadSession: vi.fn(),
}));

vi.mock("../../domains/session/repository/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domains/session/repository/sessionStore")>()),
  listSessions: mocks.listSessions,
  loadSession: mocks.loadSession,
}));

vi.mock("../../shared/fs-policy/workspace-fs-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/fs-policy/workspace-fs-policy")>()),
  getWorkspaceFsPolicy: () => ({ getRoot: () => "/workspace" }),
}));

function session(id: string, updatedAt: number): SessionMeta {
  return {
    id,
    workspaceRoot: "/workspace",
    title: `${id} title`,
    createdAt: updatedAt,
    updatedAt,
    turns: 1,
    traceIds: [],
  };
}

function createHost(choice = ""): {
  host: EvilJellyBindings;
  logSystemEvent: ReturnType<typeof vi.fn>;
  requestChoice: ReturnType<typeof vi.fn>;
} {
  const logSystemEvent = vi.fn();
  const requestChoice = vi.fn(async (_request: PromptChoiceRequest) => choice);
  return {
    host: { logSystemEvent, requestChoice } as unknown as EvilJellyBindings,
    logSystemEvent,
    requestChoice,
  };
}

describe("runtime session resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats an explicit request for the current session as a no-op", async () => {
    const { host, logSystemEvent, requestChoice } = createHost();
    const runControl = createInteractiveRunControl();

    await expect(
      tryRequestResume("/resume current", "current", host, runControl.loop),
    ).resolves.toBe(false);

    expect(logSystemEvent).toHaveBeenCalledWith("Session current is already current.\n");
    expect(mocks.loadSession).not.toHaveBeenCalled();
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(requestChoice).not.toHaveBeenCalled();
    expect(runControl.loop.take()).toEqual({ type: "none" });
  });

  it("excludes the current session from the picker", async () => {
    mocks.listSessions.mockResolvedValue([session("current", 2), session("other", 1)]);
    const { host, requestChoice } = createHost("other");
    const runControl = createInteractiveRunControl();

    await expect(tryRequestResume("/resume", "current", host, runControl.loop)).resolves.toBe(true);

    const request = requestChoice.mock.calls[0]?.[0] as PromptChoiceRequest;
    expect(request.options.map((option) => option.value)).toEqual(["other", ""]);
    expect(request.cancelValue).toBe("");
    expect(runControl.loop.take()).toEqual({ type: "resume", sessionId: "other" });
  });

  it("does not open a picker when only the current session is saved", async () => {
    mocks.listSessions.mockResolvedValue([session("current", 1)]);
    const { host, logSystemEvent, requestChoice } = createHost();
    const runControl = createInteractiveRunControl();

    await expect(tryRequestResume("/resume", "current", host, runControl.loop)).resolves.toBe(
      false,
    );

    expect(requestChoice).not.toHaveBeenCalled();
    expect(logSystemEvent).toHaveBeenCalledWith("No other saved sessions for this workspace.\n");
    expect(runControl.loop.take()).toEqual({ type: "none" });
  });
});
