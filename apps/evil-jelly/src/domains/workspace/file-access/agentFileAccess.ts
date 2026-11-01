import { equipResource, expectResource } from "@rejelly/core";
import type { FilePermission } from "../../../shared/configuration/filePermissions";
import { persistProjectFilePermission } from "../../../shared/configuration/filePermissions";
import {
  getSettings,
  invalidateSettingsCache,
  resolveUserSettingsPath,
} from "../../../shared/configuration/settings";
import { resolveRealPath } from "../../../shared/fs-policy/path-containment";
import {
  type FileAccess,
  getWorkspaceFiles,
  type ResolvedFsPath,
  type WorkspaceFiles,
} from "../../../shared/fs-policy/workspace-files";
import type {
  ExternalFileAccess,
  ToolConfirmationHandler,
} from "../../../shared/host/toolConfirmationBindings";
import { recordActiveToolApproval } from "../../../shared/tool-observation/invocationContext";
import { ExternalFileGrants, grantCovers } from "./externalGrants";

type AgentApprovalMode = "normal" | "auto";
type GrantMatch = { grant: FilePermission; scope: "session" | "always" };

export type AgentFileResolveResult =
  | ({ ok: true } & ResolvedFsPath)
  | {
      ok: false;
      error: string;
      approval?: { access: ExternalFileAccess; targetPath: string; grantRoot: string };
    };

/** Owned by one live agent session, shared by its turns and children, never journal-replayed. */
export class AgentFileAccess {
  private readonly grants = new ExternalFileGrants();
  private approvalQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceFiles: WorkspaceFiles) {}

  getRoot(): string {
    return this.workspaceFiles.getRoot();
  }

  approveExternalAccess(access: ExternalFileAccess | "read-write", grantRoot: string): void {
    this.grants.approve(
      access === "write" || access === "read-write" ? "read-write" : "read",
      grantRoot,
    );
  }

  private findGrant(access: ExternalFileAccess, targetPath: string): GrantMatch | undefined {
    const persistent = (getSettings().filePermissions ?? []).find((grant) =>
      grantCovers(grant, access, targetPath),
    );
    if (persistent) return { grant: persistent, scope: "always" };
    const grant = this.grants.find(access, targetPath);
    return grant ? { grant, scope: "session" } : undefined;
  }

  writeApproval(targetPaths: readonly string[]): "session" | "always" | undefined {
    if (targetPaths.some((target) => this.workspaceFiles.isUserSettingsPath(target)))
      return undefined;
    const external = targetPaths.filter((target) => !this.workspaceFiles.isManagedPath(target));
    if (external.length === 0) return undefined;
    const matches = external.map((target) =>
      this.workspaceFiles.agentPathError(target, "write")
        ? undefined
        : this.findGrant("write", target),
    );
    if (matches.some((match) => !match)) return undefined;
    return matches.some((match) => match?.scope === "session") ? "session" : "always";
  }

  tryResolve(
    userPath: string,
    access: FileAccess,
    approvalMode: AgentApprovalMode,
  ): AgentFileResolveResult {
    const resolved = this.workspaceFiles.classifyPath(userPath);
    const error = this.workspaceFiles.agentPathError(resolved.abs, access.kind);
    if (error) return { ok: false, error };
    if (access.kind === "write" && this.workspaceFiles.isUserSettingsPath(resolved.abs)) {
      // Do not grant the global directory. The write tool must review the concrete changes.
      return {
        ok: true,
        ...resolved,
        accessRoot: resolveRealPath(resolved.abs),
        userSettings: true,
      };
    }
    if (this.workspaceFiles.isManagedPath(resolved.abs)) {
      return this.workspaceFiles.tryResolveWorkspacePath(userPath, access);
    }
    if (access.kind === "read" && approvalMode === "auto") return { ok: true, ...resolved };
    const match = this.findGrant(access.kind, resolved.abs);
    if (match) {
      recordActiveToolApproval({
        mode: "policy",
        basis: `${match.scope} external ${match.grant.access}`,
      });
      return { ok: true, ...resolved, accessRoot: match.grant.directory };
    }
    return {
      ok: false,
      error: `Access outside workspace requires approval: ${resolved.abs}`,
      approval: {
        access: access.kind,
        targetPath: resolved.abs,
        grantRoot: this.workspaceFiles.suggestContainingDirectory(resolved.abs),
      },
    };
  }

  async resolve(
    userPath: string,
    access: FileAccess,
    mode: AgentApprovalMode,
    confirm?: ToolConfirmationHandler,
  ): Promise<AgentFileResolveResult> {
    const first = this.tryResolve(userPath, access, mode);
    if (first.ok || !first.approval || !confirm) return first;
    const previous = this.approvalQueue;
    let release!: () => void;
    this.approvalQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // Another parallel tool may have obtained a session grant while this request was queued.
      const current = this.tryResolve(userPath, access, mode);
      if (current.ok || !current.approval) return current;
      const decision = await confirm({ type: "fs_outside_access", ...current.approval });
      if (decision.action !== "accept")
        return {
          ok: false,
          error: `Access outside workspace denied: ${current.approval.targetPath}`,
        };
      const directory = resolveRealPath(current.approval.grantRoot);
      const resolved = this.workspaceFiles.classifyPath(userPath);
      const error = this.workspaceFiles.agentPathError(resolved.abs, access.kind);
      const permission: FilePermission = {
        directory: directory ?? current.approval.grantRoot,
        access: decision.fileAccess ?? (access.kind === "write" ? "read-write" : "read"),
      };
      if (error || !directory || !grantCovers(permission, access.kind, resolved.abs)) {
        return {
          ok: false,
          error:
            error ??
            "Access denied: Path changed or resolves outside the approved directory. Use the explicit real path.",
        };
      }
      if (decision.scope === "always") {
        persistProjectFilePermission(resolveUserSettingsPath(), this.getRoot(), permission);
        invalidateSettingsCache();
      } else if (decision.scope === "session") {
        this.grants.approve(permission.access, directory);
      }
      return { ok: true, ...resolved, accessRoot: directory };
    } catch (error) {
      return {
        ok: false,
        error: `Cannot authorize external access: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      release();
    }
  }
}

const AGENT_FILE_ACCESS_KEY = "evil-jelly:workspace-file-access";

export async function equipAgentFileAccess(): Promise<void> {
  if (expectResource<AgentFileAccess>(AGENT_FILE_ACCESS_KEY, { optional: true })) return;
  const workspaceFiles = getWorkspaceFiles();
  await equipResource(AGENT_FILE_ACCESS_KEY, {
    create: async () => new AgentFileAccess(workspaceFiles),
    deps: [workspaceFiles.getRoot()],
    expose: true,
  });
}

export function getAgentFileAccess(): AgentFileAccess {
  try {
    const access = expectResource<AgentFileAccess>(AGENT_FILE_ACCESS_KEY, { optional: true });
    if (access?.getRoot() === getWorkspaceFiles().getRoot()) return access;
  } catch {
    /* Direct non-agent callers get an isolated, non-caching scope. */
  }
  return new AgentFileAccess(getWorkspaceFiles());
}
