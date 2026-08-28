import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWindowsVtInputRestorer } from "./windowsVtInput";

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
}

async function flushAsyncRestore(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Windows VT input restorer", () => {
  it("starts PowerShell in the background and coalesces concurrent requests", async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    );
    const restorer = createWindowsVtInputRestorer(spawnProcess);

    restorer.request();
    restorer.request();

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["inherit", "ignore", "ignore"],
        windowsHide: true,
      }),
    );
    expect(children[0]?.unref).toHaveBeenCalledOnce();

    children[0]?.emit("exit", 0);
    await flushAsyncRestore();
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("falls back to pwsh when Windows PowerShell fails", async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    );
    const restorer = createWindowsVtInputRestorer(spawnProcess);

    restorer.request();
    children[0]?.emit("exit", 1);
    await flushAsyncRestore();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[1]?.[0]).toBe("pwsh.exe");
  });

  it("cancels an active restore without starting the fallback", async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => child,
    );
    const restorer = createWindowsVtInputRestorer(spawnProcess);

    restorer.request();
    restorer.cancel();
    child.emit("exit", 1);
    await flushAsyncRestore();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("restarts after raw mode is re-enabled while a cancelled child exits", async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    );
    const restorer = createWindowsVtInputRestorer(spawnProcess);

    restorer.request();
    restorer.cancel();
    restorer.request();
    children[0]?.emit("exit", null);
    await flushAsyncRestore();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[1]?.[0]).toBe("powershell.exe");
  });
});
