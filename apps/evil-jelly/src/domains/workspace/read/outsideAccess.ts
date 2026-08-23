import {
  type FsAccessKind,
  type FsIntent,
  getWorkspaceFsPolicy,
  type ResolvedFsPath,
} from "../../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { getBinding } from "../../../shared/host/context";

type ToolFsIntent = Exclude<FsIntent, "inside">;

export type ResolveToolFsPathResult =
  | ({ ok: true } & ResolvedFsPath)
  | { ok: false; error: string };

function tryGetBinding(): EvilJellyBindings | null {
  try {
    return getBinding();
  } catch {
    return null;
  }
}

export async function resolveToolFsPath(
  userPath: string,
  intent: ToolFsIntent,
  access: FsAccessKind,
): Promise<ResolveToolFsPathResult> {
  const policy = getWorkspaceFsPolicy();
  const host = tryGetBinding();
  const mode = host?.getAgentMode?.() ?? "normal";
  const first = policy.tryResolve(userPath, {
    intent,
    approvalMode: mode,
    access,
  });
  if (first.ok) {
    return first;
  }
  if (!first.needsApproval || !first.mode || !first.targetPath || !first.approveDir) {
    return { ok: false, error: first.error };
  }
  if (!host) {
    return { ok: false, error: first.error };
  }

  const decision = await host.confirmTool({
    type: "fs_outside_access",
    mode: first.mode,
    targetPath: first.targetPath,
    approveDir: first.approveDir,
  });
  if (decision.action !== "accept") {
    return { ok: false, error: `Access outside workspace denied: ${first.targetPath}` };
  }

  policy.approveOutsideAccess(first.mode, first.approveDir);
  const second = policy.tryResolve(userPath, {
    intent,
    approvalMode: mode,
    access,
  });
  if (second.ok) {
    return second;
  }
  return { ok: false, error: second.error };
}
