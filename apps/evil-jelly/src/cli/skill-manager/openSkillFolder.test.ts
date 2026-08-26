import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { openSkillFolderInFileManager } from "./openSkillFolder";

const expectedFile =
  process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";

function childWith(events: Record<string, () => void>) {
  return {
    once: vi.fn((event: string, handler: () => void) => {
      events[event] = handler;
    }),
    unref: vi.fn(),
  };
}

describe("openSkillFolderInFileManager", () => {
  afterEach(() => vi.clearAllMocks());

  it("opens the absolute Skill root without hiding the file manager", async () => {
    const rootPath = path.resolve("fixtures", "skills", "review");
    const events: Record<string, () => void> = {};
    const child = childWith(events);
    spawnMock.mockReturnValue(child);

    const pending = openSkillFolderInFileManager(rootPath);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    events.spawn?.();
    await pending;

    expect(spawnMock).toHaveBeenCalledWith(expectedFile, [rootPath], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects relative paths before spawning", async () => {
    await expect(openSkillFolderInFileManager("relative/skill")).rejects.toThrow("absolute path");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
