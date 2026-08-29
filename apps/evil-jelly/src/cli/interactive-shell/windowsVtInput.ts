import { type SpawnOptions, spawn } from "node:child_process";

const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

let installed = false;

interface BackgroundProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
  kill(): boolean;
  unref(): void;
}

type SpawnBackgroundProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => BackgroundProcess;

const enableVtInputScript = `
Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern System.IntPtr GetStdHandle(int nStdHandle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool GetConsoleMode(System.IntPtr hConsoleHandle, out int lpMode);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetConsoleMode(System.IntPtr hConsoleHandle, int dwMode);
'@
$h = [Win32.Console]::GetStdHandle(-10)
$mode = 0
if ([Win32.Console]::GetConsoleMode($h, [ref]$mode)) {
  [void][Win32.Console]::SetConsoleMode($h, ($mode -bor ${ENABLE_VIRTUAL_TERMINAL_INPUT}))
}
`;

const powershellArgs = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  enableVtInputScript,
] as const;

const spawnBackgroundProcess: SpawnBackgroundProcess = (command, args, options) =>
  spawn(command, args, options);

function runPowerShell(
  command: string,
  spawnProcess: SpawnBackgroundProcess,
  onSpawn: (child: BackgroundProcess) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: BackgroundProcess;
    try {
      child = spawnProcess(command, powershellArgs, {
        stdio: ["inherit", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    onSpawn(child);
    child.unref();
    let settled = false;
    const settle = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(succeeded);
    };
    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
}

export interface WindowsVtInputRestorer {
  request: () => void;
  cancel: () => void;
}

/** Runs at most one PowerShell restore at a time and cancels stale work on raw-mode exit. */
export function createWindowsVtInputRestorer(
  spawnProcess: SpawnBackgroundProcess = spawnBackgroundProcess,
): WindowsVtInputRestorer {
  let desired = false;
  let generation = 0;
  let running = false;
  let activeChild: BackgroundProcess | undefined;

  const run = async (runGeneration: number): Promise<void> => {
    running = true;
    try {
      for (const command of ["powershell.exe", "pwsh.exe"]) {
        if (!desired || runGeneration !== generation) return;
        const succeeded = await runPowerShell(command, spawnProcess, (child) => {
          activeChild = child;
        });
        activeChild = undefined;
        if (!desired || runGeneration !== generation) return;
        if (succeeded) return;
      }
    } finally {
      running = false;
      activeChild = undefined;
      // Raw mode may have been disabled and re-enabled while a cancelled child was exiting.
      if (desired && runGeneration !== generation) {
        void run(generation);
      }
    }
  };

  return {
    request: () => {
      desired = true;
      if (!running) void run(generation);
    },
    cancel: () => {
      desired = false;
      generation += 1;
      try {
        activeChild?.kill();
      } catch {
        // Best-effort: a child may have exited between the state check and kill().
      }
    },
  };
}

const vtInputRestorer = createWindowsVtInputRestorer();

/**
 * Node's Windows raw mode can clear ENABLE_VIRTUAL_TERMINAL_INPUT, which makes
 * Shift+Tab collapse to a plain tab byte. Re-apply VT input asynchronously after
 * raw-mode enable so PowerShell startup cannot block Ink's first render.
 */
export function installWindowsVirtualTerminalInputPatch(): void {
  if (installed || process.platform !== "win32" || !process.stdin.isTTY) {
    return;
  }
  const setRawMode = process.stdin.setRawMode?.bind(process.stdin);
  if (!setRawMode) {
    return;
  }
  installed = true;
  process.once("exit", vtInputRestorer.cancel);
  process.stdin.setRawMode = ((enabled: boolean) => {
    if (!enabled) {
      vtInputRestorer.cancel();
    }
    const result = setRawMode(enabled);
    if (enabled) {
      vtInputRestorer.request();
    }
    return result;
  }) as typeof process.stdin.setRawMode;
}
