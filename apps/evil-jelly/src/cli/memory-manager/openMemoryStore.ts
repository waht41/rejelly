import { spawn } from "node:child_process";
import { resolvePersistentMemoryRoot } from "../../domains/memory/repository/memoryPaths";

type FileManagerCommand = { file: string; args: string[] };

function fileManagerCommand(target: string): FileManagerCommand {
  if (process.platform === "win32") return { file: "explorer.exe", args: [target] };
  if (process.platform === "darwin") return { file: "open", args: [target] };
  return { file: "xdg-open", args: [target] };
}

/** Opens only Evil Jelly's own persistent Memory Store directory, never a caller-supplied path. */
export function showMemoryStoreInExplorer(): Promise<void> {
  const command = fileManagerCommand(resolvePersistentMemoryRoot());
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
