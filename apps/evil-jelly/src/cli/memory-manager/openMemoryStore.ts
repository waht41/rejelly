import { spawn } from "node:child_process";
import path from "node:path";
import type { MemoryScope } from "../../domains/memory/model/memorySchema";
import {
  ensurePersistentMemoryRoot,
  resolveMemoryPaths,
} from "../../domains/memory/repository/memoryPaths";

type FileManagerCommand = { file: string; args: string[] };

function fileManagerCommand(target: string): FileManagerCommand {
  if (process.platform === "win32") {
    return { file: "explorer.exe", args: [`/select,${target}`] };
  }
  if (process.platform === "darwin") return { file: "open", args: ["-R", target] };
  // xdg-open has no portable "reveal file" flag, so open the containing directory.
  return { file: "xdg-open", args: [path.dirname(target)] };
}

/** Reveals an application-owned scope file; callers cannot supply an arbitrary path. */
export async function revealMemoryFileInExplorer(options: {
  scope: MemoryScope;
  workspaceRoot: string;
}): Promise<void> {
  await ensurePersistentMemoryRoot();
  const paths = resolveMemoryPaths(options.workspaceRoot);
  if (options.scope === "project" && paths.projectUnavailable) {
    throw new Error(paths.projectUnavailable);
  }
  const target = options.scope === "user" ? paths.userFile : paths.projectFile;
  const command = fileManagerCommand(target);
  await new Promise<void>((resolve, reject) => {
    // windowsHide must stay off: on Windows it suppresses the Explorer window
    // (CREATE_NO_WINDOW), so the folder opens with no visible window.
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
