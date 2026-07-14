import { spawnSync } from "node:child_process";

const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

let installed = false;

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

function runPowerShell(command: string): boolean {
  const result = spawnSync(
    command,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      enableVtInputScript,
    ],
    {
      stdio: ["inherit", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  return result.status === 0;
}

function enableWindowsVirtualTerminalInput(): void {
  if (process.platform !== "win32" || !process.stdin.isTTY) {
    return;
  }
  if (runPowerShell("powershell.exe")) {
    return;
  }
  runPowerShell("pwsh.exe");
}

/**
 * Node's Windows raw mode can clear ENABLE_VIRTUAL_TERMINAL_INPUT, which makes
 * Shift+Tab collapse to a plain tab byte. Re-apply VT input immediately after
 * any raw-mode enable so Ink receives the back-tab escape sequence.
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
  process.stdin.setRawMode = ((enabled: boolean) => {
    const result = setRawMode(enabled);
    if (enabled) {
      enableWindowsVirtualTerminalInput();
    }
    return result;
  }) as typeof process.stdin.setRawMode;
}
