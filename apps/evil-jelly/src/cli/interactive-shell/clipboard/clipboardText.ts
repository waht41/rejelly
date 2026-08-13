import { spawn } from "node:child_process";

const CLIPBOARD_TIMEOUT_MS = 5_000;

type ClipboardCommand = {
  file: string;
  args: string[];
};

function windowsClipboardCommand(): ClipboardCommand {
  const script =
    "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); " +
    "Set-Clipboard -Value ([Console]::In.ReadToEnd())";
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
  };
}

function clipboardCommands(): ClipboardCommand[] {
  if (process.platform === "win32") {
    return [windowsClipboardCommand()];
  }
  if (process.platform === "darwin") {
    return [{ file: "pbcopy", args: [] }];
  }
  return [
    { file: "wl-copy", args: [] },
    { file: "xclip", args: ["-selection", "clipboard"] },
    { file: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function runClipboardCommand(command: ClipboardCommand, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`${command.file} timed out`));
    }, CLIPBOARD_TIMEOUT_MS);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command.file} exited with code ${code}`));
    });
    child.stdin.end(text, "utf8");
  });
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const errors: string[] = [];
  for (const command of clipboardCommands()) {
    try {
      await runClipboardCommand(command, text);
      return;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors.filter(Boolean).join("; ") || "No clipboard command succeeded");
}
