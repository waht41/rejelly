import { requestMcpAccess } from "../../domains/mcp/management/requestAccess";
import {
  formatMcpSessionStatus,
  type McpSessionControl,
} from "../../domains/mcp/management/sessionControl";
import type { PromptChoiceRequest } from "../../shared/host/inputBindings";

export interface McpCommandPorts {
  readonly control?: McpSessionControl;
  readonly selectedServerIds: readonly string[];
  setSelectedServerIds(selectedServerIds: readonly string[]): void;
  recordSelection(selectedServerIds: readonly string[]): Promise<void>;
  requestChoice(request: PromptChoiceRequest): Promise<string>;
  logSystem(message: string): void;
}

function usage(): string {
  return (
    "Usage: /mcp | /mcp use <serverId> | /mcp unuse <serverId> | " +
    "/mcp reload [serverId] | /mcp permissions | /mcp revoke <serverId>[/<tool>]"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleMcpCommand(rawInput: string, ports: McpCommandPorts): Promise<void> {
  const { control } = ports;
  if (!control) {
    ports.logSystem("MCP runtime is unavailable.\n");
    return;
  }
  const args = rawInput.slice("/mcp".length).trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    ports.logSystem(formatMcpSessionStatus(control.status(ports.selectedServerIds)));
    return;
  }
  const [rawAction, serverId, ...extra] = args;
  const action = rawAction?.toLocaleLowerCase();
  if (action === "permissions" && !serverId && extra.length === 0) {
    const permissions = control.persistentPermissions();
    ports.logSystem(
      permissions.length === 0
        ? "MCP persistent permissions: none.\n"
        : `MCP persistent permissions:\n${permissions
            .map(
              (permission) =>
                `  ${permission.serverId}: server=${permission.chatAccess ? "allow" : "ask"}; ` +
                `tools=${permission.nativeToolNames.join(",") || "none"}`,
            )
            .join("\n")}\n`,
    );
    return;
  }
  if (action === "revoke" && serverId && extra.length === 0) {
    const separator = serverId.indexOf("/");
    const targetServerId = separator < 0 ? serverId : serverId.slice(0, separator);
    const nativeToolName = separator < 0 ? undefined : serverId.slice(separator + 1);
    if (!targetServerId || (separator >= 0 && !nativeToolName)) {
      ports.logSystem(`${usage()}\n`);
      return;
    }
    await control.revokePersistentPermissions(targetServerId, nativeToolName);
    ports.logSystem(
      nativeToolName
        ? `Revoked persistent MCP tool permission ${targetServerId}/${nativeToolName}.\n`
        : `Revoked persistent MCP permissions for ${targetServerId}.\n`,
    );
    return;
  }
  if (action === "reload" && extra.length === 0) {
    try {
      await control.reload(serverId);
      ports.logSystem(
        serverId ? `MCP server ${serverId} reloaded.\n` : "MCP configuration reloaded.\n",
      );
    } catch (error) {
      ports.logSystem(`MCP reload failed: ${errorMessage(error)}\n`);
    }
    return;
  }
  if ((action !== "use" && action !== "unuse") || !serverId || extra.length > 0) {
    ports.logSystem(`${usage()}\n`);
    return;
  }

  const rows = control.status(ports.selectedServerIds);
  const row = rows.find((candidate) => candidate.serverId === serverId);
  if (action === "use") {
    const result = await requestMcpAccess(
      { serverId, reason: "Explicit /mcp use command" },
      {
        control,
        selectedServerIds: () => ports.selectedServerIds,
        approve: async (proposal) => {
          if (!proposal.requiresTrust) return "session";
          const source =
            proposal.source.kind === "dynamic"
              ? `dynamic:${proposal.source.sourceId}`
              : proposal.source.kind;
          const selected = await ports.requestChoice({
            message:
              `Trust workspace MCP server ${serverId}?\n` +
              `Source: ${source}\nFingerprint: ${proposal.configFingerprint}`,
            options: [
              { key: "y", label: "Trust this fingerprint", value: "trust" },
              { key: "n", label: "Cancel", value: "cancel" },
            ],
            cancelValue: "cancel",
          });
          return selected === "trust" ? "session" : false;
        },
        commitSelection: async (selectedServerIds) => {
          await ports.recordSelection(selectedServerIds);
          ports.setSelectedServerIds(selectedServerIds);
        },
      },
    );
    ports.logSystem(
      result.status === "granted"
        ? `MCP server ${serverId} selected for this session (${result.connection}).\n`
        : result.status === "denied"
          ? `MCP server ${serverId} was not selected.\n`
          : `MCP server ${serverId} unavailable: ${result.message}\n`,
    );
    return;
  }

  if (!row) {
    ports.logSystem(`Unknown MCP server: ${serverId}.\n`);
    return;
  }
  const next = new Set(ports.selectedServerIds);
  next.delete(serverId);
  const selectedServerIds = [...next].sort();
  ports.setSelectedServerIds(selectedServerIds);
  await ports.recordSelection(selectedServerIds);
  ports.logSystem(`MCP server ${serverId} removed from this session selection.\n`);
}
