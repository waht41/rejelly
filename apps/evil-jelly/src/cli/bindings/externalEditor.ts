import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

function isVsCodeCli(cmd: string): boolean {
  const base = basename(cmd).toLowerCase();
  return base === "code" || base === "code.cmd" || base === "code.exe";
}

function parseEditorEnv(editorEnv: string): { cmd: string; args: string[] } {
  const trimmed = editorEnv.trim();
  if (!trimmed) {
    return { cmd: process.platform === "win32" ? "notepad" : "vi", args: [] };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return { cmd: parts[0]!, args: parts.slice(1) };
}

function warnIfCodeWithoutWait(cmd: string, extraArgs: string[]): void {
  if (!isVsCodeCli(cmd)) {
    return;
  }
  if (extraArgs.includes("--wait")) {
    return;
  }
  process.stderr.write(
    '[evil-jelly] EDITOR points at VS Code without --wait; the buffer may be read before you save. Prefer EDITOR="code --wait" (or Remote: use `code` with --wait in your shell profile).\n',
  );
}

export async function editContentInExternalEditor(
  content: string,
  originalPath: string,
): Promise<string> {
  const ext = extname(originalPath) || ".txt";
  const file = join(tmpdir(), `evil-jelly-edit-${randomBytes(8).toString("hex")}${ext}`);
  await writeFile(file, content, "utf8");

  const editorEnv =
    process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
  const { cmd, args: editorArgs } = parseEditorEnv(editorEnv);
  warnIfCodeWithoutWait(cmd, editorArgs);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...editorArgs, file], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(
          new Error(
            `Editor exited with code ${code}. Please ensure you saved the file before closing.`,
          ),
        );
      }
    });
  });
  const modified = await readFile(file, "utf8");
  await rm(file, { force: true }).catch(() => undefined);
  return modified;
}
