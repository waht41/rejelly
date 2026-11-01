import type { FileAccess, ResolvedFsPath } from "../../../shared/fs-policy/workspace-files";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { getBinding } from "../../../shared/host/context";
import { getAgentFileAccess } from "./agentFileAccess";

export type ResolveFileToolPathResult =
  | ({ ok: true } & ResolvedFsPath)
  | { ok: false; error: string };

function tryGetBinding(): EvilJellyBindings | null {
  try {
    return getBinding();
  } catch {
    return null;
  }
}

export async function resolveFileToolPath(
  userPath: string,
  access: FileAccess,
): Promise<ResolveFileToolPathResult> {
  const agentFileAccess = getAgentFileAccess();
  const host = tryGetBinding();
  const mode = host?.getAgentMode?.() ?? "normal";
  return agentFileAccess.resolve(userPath, access, mode, host?.confirmTool);
}
