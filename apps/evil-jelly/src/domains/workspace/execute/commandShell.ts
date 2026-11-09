import { spawnSync } from "node:child_process";
import path from "node:path";

export interface CommandShell {
  readonly path: string;
  readonly kind: "pwsh" | "windows-powershell" | "posix";
}

let windowsShell: CommandShell | undefined;

/** Select once on first use so Environment and execution use the same Windows shell. */
export function getCommandShell(): CommandShell {
  if (process.platform !== "win32") {
    return { path: process.env.SHELL ?? "/bin/sh", kind: "posix" };
  }
  if (windowsShell) return windowsShell;

  // Probe only the interpreter, never the user's command. No profile, input, or shell wrapping.
  const probe = spawnSync(
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; " +
        "if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }; " +
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
        "[Console]::Write((Join-Path $PSHOME 'pwsh.exe'))",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024,
    },
  );
  const pwshPath = probe.stdout?.trim();
  if (!probe.error && probe.status === 0 && pwshPath && path.win32.isAbsolute(pwshPath)) {
    windowsShell = { path: pwshPath, kind: "pwsh" };
  } else {
    const windowsRoot = process.env.SystemRoot;
    windowsShell = {
      path: windowsRoot
        ? path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe",
      kind: "windows-powershell",
    };
  }
  return windowsShell;
}
