import path from "node:path";
import fg from "fast-glob";
import { getWorkspaceFsPolicy } from "./workspace-fs-policy";

/**
 * Execute a workspace-rooted glob behind the shared filesystem boundary.
 *
 * Pattern selection and domain-specific filtering belong to the caller; this adapter owns the
 * raw filesystem walk so workspace domain code does not import a filesystem-backed glob library.
 */
export async function globWorkspaceFiles(patterns: string[], ignore: string[]): Promise<string[]> {
  const policy = getWorkspaceFsPolicy();
  const entries = await fg(patterns, {
    cwd: policy.getRoot(),
    dot: false,
    ignore,
    absolute: false,
    onlyFiles: true,
  });
  return entries.map((entry) => entry.split(path.sep).join("/"));
}
