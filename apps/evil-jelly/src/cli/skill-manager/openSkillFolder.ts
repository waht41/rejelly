import { spawn } from "node:child_process";
import path from "node:path";

type FileManagerCommand = { file: string; args: string[] };

function fileManagerCommand(target: string): FileManagerCommand {
  if (process.platform === "win32") return { file: "explorer.exe", args: [target] };
  if (process.platform === "darwin") return { file: "open", args: [target] };
  return { file: "xdg-open", args: [target] };
}

/** Open one canonical Skill root supplied by the current host-owned Skill snapshot. */
export async function openSkillFolderInFileManager(rootPath: string): Promise<void> {
  if (!path.isAbsolute(rootPath)) {
    throw new Error("Skill root must be an absolute path.");
  }
  const command = fileManagerCommand(rootPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
