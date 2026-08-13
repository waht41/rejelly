import fs from "node:fs";
import { setWorkspaceRoot } from "../../shared/fs-policy/workspace-fs-policy";

function assertDirectory(label: string, dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: cannot access ${dir}: ${msg}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`${label}: not a directory: ${dir}`);
    process.exit(1);
  }
}

/** Binds setWorkspaceRoot to CLI --workspace or the current directory. */
export function applyWorkspaceRootFromArgs(workspace: string | undefined): void {
  const root = workspace ?? process.cwd();
  assertDirectory(workspace !== undefined ? "--workspace" : "workspace root", root);
  setWorkspaceRoot(root);
}
