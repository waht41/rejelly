import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: probe,
}));

describe("Windows command shell selection", () => {
  beforeEach(() => {
    vi.resetModules();
    probe.mockReset();
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("pins the discovered pwsh path and never switches shells after a command spawn failure", async () => {
    const selectedPath = "C:\\missing-pwsh-fixture\\pwsh.exe";
    probe.mockReturnValue({ status: 0, stdout: `${selectedPath}\r\n` });
    const { getCommandShell } = await import("./commandShell");
    const selected = getCommandShell();
    expect(selected).toEqual({ path: selectedPath, kind: "pwsh" });
    expect(probe).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
      expect.objectContaining({ timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }),
    );

    const spawn = vi.spyOn(childProcess, "spawn");
    const { executeShellCommand } = await import("./executeShellCommand");
    const result = await executeShellCommand({
      command: "must-not-be-replayed",
      cwd: process.cwd(),
    });
    expect(result.error?.code).toBe("ENOENT");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe(selectedPath);
    expect(getCommandShell()).toBe(selected);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: null, stdout: "", error: { code: "ENOENT" } },
    { status: null, stdout: "", error: { code: "ETIMEDOUT" } },
    { status: 1, stdout: "" },
    { status: 0, stdout: "not an executable path" },
  ])("pins Windows PowerShell when the pwsh probe is unusable (%j)", async (result) => {
    probe.mockReturnValue(result);
    const { getCommandShell } = await import("./commandShell");
    const selected = getCommandShell();
    expect(selected).toEqual({
      path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      kind: "windows-powershell",
    });
    probe.mockReturnValue({ status: 0, stdout: "C:\\PowerShell\\7\\pwsh.exe" });
    expect(getCommandShell()).toBe(selected);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("leaves POSIX shell reporting unchanged and never probes PowerShell", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    vi.stubEnv("SHELL", "/bin/zsh");
    const { getCommandShell } = await import("./commandShell");
    expect(getCommandShell()).toEqual({ path: "/bin/zsh", kind: "posix" });
    expect(probe).not.toHaveBeenCalled();
  });
});
