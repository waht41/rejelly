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
  const first = agentFileAccess.tryResolve(userPath, access, mode);
  if (first.ok) {
    return first;
  }
  if (!first.approval || !host) {
    return { ok: false, error: first.error };
  }

  const decision = await host.confirmTool({
    type: "fs_outside_access",
    access: first.approval.access,
    targetPath: first.approval.targetPath,
    grantRoot: first.approval.grantRoot,
  });
  if (decision.action !== "accept") {
    return { ok: false, error: `Access outside workspace denied: ${first.approval.targetPath}` };
  }

  agentFileAccess.approveExternalAccess(first.approval.access, first.approval.grantRoot);
  const second = agentFileAccess.tryResolve(userPath, access, mode);
  return second.ok ? second : { ok: false, error: second.error };
}
