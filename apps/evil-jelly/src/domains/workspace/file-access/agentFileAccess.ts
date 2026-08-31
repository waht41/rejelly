import {
  type FileAccess,
  getWorkspaceFiles,
  type ResolvedFsPath,
  type WorkspaceFiles,
} from "../../../shared/fs-policy/workspace-files";
import { isSensitiveFsPath, sensitiveFsPathError } from "../../../shared/fs-policy/workspace-scan";
import type { ExternalFileAccess } from "../../../shared/host/toolConfirmationBindings";
import { ExternalFileGrants } from "./externalGrants";

type AgentApprovalMode = "normal" | "auto";

export type AgentFileResolveResult =
  | ({ ok: true } & ResolvedFsPath)
  | {
      ok: false;
      error: string;
      approval?: {
        access: ExternalFileAccess;
        targetPath: string;
        grantRoot: string;
      };
    };

export class AgentFileAccess {
  private readonly grants = new ExternalFileGrants();

  constructor(private readonly workspaceFiles: WorkspaceFiles) {}

  getRoot(): string {
    return this.workspaceFiles.getRoot();
  }

  approveExternalAccess(access: ExternalFileAccess, grantRoot: string): void {
    this.grants.approve(access, grantRoot);
  }

  tryResolve(
    userPath: string,
    access: FileAccess,
    approvalMode: AgentApprovalMode,
  ): AgentFileResolveResult {
    const resolved = this.workspaceFiles.classifyPath(userPath);
    if (!resolved.outside) {
      return this.workspaceFiles.tryResolveWorkspacePath(userPath, access);
    }
    if (isSensitiveFsPath(resolved.abs)) {
      return { ok: false, error: sensitiveFsPathError(resolved.abs) };
    }

    const externalAccess = access.kind;
    if (externalAccess === "read" && approvalMode === "auto") {
      return { ok: true, ...resolved };
    }
    if (this.grants.has(externalAccess, resolved.abs)) {
      return { ok: true, ...resolved };
    }
    return {
      ok: false,
      error: `Access outside workspace requires approval: ${resolved.abs}`,
      approval: {
        access: externalAccess,
        targetPath: resolved.abs,
        grantRoot: this.workspaceFiles.suggestContainingDirectory(resolved.abs),
      },
    };
  }
}

let agentFileAccess: AgentFileAccess | undefined;

export function getAgentFileAccess(): AgentFileAccess {
  const workspaceFiles = getWorkspaceFiles();
  if (!agentFileAccess || agentFileAccess.getRoot() !== workspaceFiles.getRoot()) {
    agentFileAccess = new AgentFileAccess(workspaceFiles);
  }
  return agentFileAccess;
}
