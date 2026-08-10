import { beforeEach, describe, expect, it, vi } from "vitest";
import { takePendingResume } from "../../../services/session/resumeControl";
import type { SessionMeta } from "../../../services/session/sessionStore";
import type { EvilJellyHostBindings, HostChoiceOption } from "../../../shared/types";
import { tryRequestResume } from "./MainCliAgent";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  loadSession: vi.fn(),
}));

vi.mock("../../../services/session/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/session/sessionStore")>()),
  listSessions: mocks.listSessions,
  loadSession: mocks.loadSession,
}));

vi.mock("../../../shared/fs-policy/workspace-fs-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/fs-policy/workspace-fs-policy")>()),
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
  host: EvilJellyHostBindings;
  logSystemEvent: ReturnType<typeof vi.fn>;
  requestChoice: ReturnType<typeof vi.fn>;
} {
  const logSystemEvent = vi.fn();
  const requestChoice = vi.fn(async (_message: string, _options: HostChoiceOption[]) => choice);
  return {
    host: { logSystemEvent, requestChoice } as unknown as EvilJellyHostBindings,
    logSystemEvent,
    requestChoice,
  };
}

describe("runtime session resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    takePendingResume();
  });

  it("treats an explicit request for the current session as a no-op", async () => {
    const { host, logSystemEvent, requestChoice } = createHost();

    await expect(tryRequestResume("/resume current", "current", host)).resolves.toBe(false);

    expect(logSystemEvent).toHaveBeenCalledWith("Session current is already current.\n");
    expect(mocks.loadSession).not.toHaveBeenCalled();
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(requestChoice).not.toHaveBeenCalled();
    expect(takePendingResume()).toBeNull();
  });

  it("excludes the current session from the picker", async () => {
    mocks.listSessions.mockResolvedValue([session("current", 2), session("other", 1)]);
    const { host, requestChoice } = createHost("other");

    await expect(tryRequestResume("/resume", "current", host)).resolves.toBe(true);

    const options = requestChoice.mock.calls[0]?.[1] as HostChoiceOption[];
    expect(options.map((option) => option.value)).toEqual(["other", ""]);
    expect(takePendingResume()).toBe("other");
  });

  it("does not open a picker when only the current session is saved", async () => {
    mocks.listSessions.mockResolvedValue([session("current", 1)]);
    const { host, logSystemEvent, requestChoice } = createHost();

    await expect(tryRequestResume("/resume", "current", host)).resolves.toBe(false);

    expect(requestChoice).not.toHaveBeenCalled();
    expect(logSystemEvent).toHaveBeenCalledWith("No other saved sessions for this workspace.\n");
    expect(takePendingResume()).toBeNull();
  });
});
