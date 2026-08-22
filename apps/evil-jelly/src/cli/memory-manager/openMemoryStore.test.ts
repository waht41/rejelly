import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const ensurePersistentMemoryRootMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

vi.mock("../../domains/memory/repository/memoryPaths", () => ({
  ensurePersistentMemoryRoot: ensurePersistentMemoryRootMock,
  resolveMemoryPaths: () => ({
    userFile: "C:\\Users\\probe\\.evil-jelly\\memory\\user.json",
    projectFile:
      "C:\\Users\\probe\\.evil-jelly\\memory\\projects\\cdcbdd7e-fcf8-4ba5-a1d2-96d119b3ce84\\memory.json",
  }),
}));

import { revealMemoryFileInExplorer } from "./openMemoryStore";

const expectedFile =
  process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
const projectFile =
  "C:\\Users\\probe\\.evil-jelly\\memory\\projects\\cdcbdd7e-fcf8-4ba5-a1d2-96d119b3ce84\\memory.json";

function childWith(events: Record<string, () => void>) {
  return {
    once: vi.fn((event: string, handler: () => void) => {
      events[event] = handler;
    }),
    unref: vi.fn(),
  };
}

describe("revealMemoryFileInExplorer", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reveals the concrete project memory file without hiding the file manager", async () => {
    ensurePersistentMemoryRootMock.mockResolvedValue(undefined);
    const events: Record<string, () => void> = {};
    const child = childWith(events);
    spawnMock.mockReturnValue(child);

    const pending = revealMemoryFileInExplorer({
      scope: "project",
      workspaceRoot: "E:\\workspace",
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    events.spawn?.();
    await pending;

    expect(ensurePersistentMemoryRootMock).toHaveBeenCalledOnce();
    const [file, args, options] = spawnMock.mock.calls[0];
    expect(file).toBe(expectedFile);
    expect(args).toEqual(
      process.platform === "win32"
        ? [`/select,${projectFile}`]
        : process.platform === "darwin"
          ? ["-R", projectFile]
          : ["."],
    );
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(options.windowsHide).toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects when the file manager cannot be spawned", async () => {
    ensurePersistentMemoryRootMock.mockResolvedValue(undefined);
    const events: Record<string, () => void> = {};
    const child = childWith(events);
    spawnMock.mockReturnValue(child);

    const pending = revealMemoryFileInExplorer({ scope: "user", workspaceRoot: "E:\\workspace" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    events.error?.();
    await expect(pending).rejects.toBeUndefined();
  });
});
