import { requestMcpAccess } from "../../domains/mcp/management/requestAccess";
import type {
  McpSessionControl,
  McpSessionStatusRow,
} from "../../domains/mcp/management/sessionControl";
import type {
  McpManagerAction,
  McpManagerRequest,
  PromptChoiceRequest,
} from "../../shared/host/inputBindings";

export interface McpCommandPorts {
  readonly control?: McpSessionControl;
  selectedServerIds(): readonly string[];
  setSelectedServerIds(selectedServerIds: readonly string[]): void;
  recordSelection(selectedServerIds: readonly string[]): Promise<void>;
  requestChoice(request: PromptChoiceRequest): Promise<string>;
  requestManager?: (request: McpManagerRequest) => Promise<McpManagerAction>;
  logSystem(message: string): void;
}

const LEGACY_ACTIONS = new Set(["use", "unuse", "reload", "permissions", "revoke"]);

export function isMcpLocalCommand(commandText: string): boolean {
  const args = commandText.trim().split(/\s+/);
  if (args[0]?.toLocaleLowerCase() !== "/mcp") return false;
  if (args.length === 1) return true;
  const action = args[1]?.toLocaleLowerCase();
  if (!action || !LEGACY_ACTIONS.has(action)) return false;
  if (action === "permissions") return args.length === 2;
  if (action === "reload") return args.length <= 3;
  return args.length === 3;
}

function usage(): string {
  return "Use /mcp to open the MCP manager.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(row: McpSessionStatusRow): string {
  return row.source.kind === "dynamic" ? `dynamic:${row.source.sourceId}` : row.source.kind;
}

function managerRequest(
  rows: readonly McpSessionStatusRow[],
  selectedServerId?: string,
): McpManagerRequest {
  return {
    rows: rows.map((row) => ({
      serverId: row.serverId,
      source: sourceLabel(row),
      exposure: row.exposure,
      selected: row.selected,
      persistentAccess: row.persistentAccess,
      routable: row.routable,
      connection: row.connection,
      toolCount: row.toolCount,
      ...(row.error ? { detail: row.error.replace(/\s+/g, " ").trim() } : {}),
    })),
    ...(selectedServerId ? { selectedServerId } : {}),
  };
}

async function requestManagerFallback(
  request: McpManagerRequest,
  requestChoice: McpCommandPorts["requestChoice"],
): Promise<McpManagerAction> {
  const selected = await requestChoice({
    message: "MCP servers",
    options: [
      ...request.rows.map((row, index) => ({
        key: index < 9 ? String(index + 1) : "",
        label: `${row.selected || row.routable ? "●" : "○"} ${row.serverId} · ${row.connection} · ${row.toolCount} tools`,
        value: row.serverId,
      })),
      { key: "x", label: "Close", value: "" },
    ],
    cancelValue: "",
  });
  if (!selected) return { action: "close" };
  const row = request.rows.find((candidate) => candidate.serverId === selected)!;
  const action = await requestChoice({
    message: `MCP ${row.serverId}`,
    options: [
      {
        key: "u",
        label: row.selected ? "Remove from this session" : "Use for this session",
        value: "toggle",
      },
      { key: "r", label: "Reload connection", value: "reload" },
      { key: "p", label: "Persistent permissions", value: "permissions" },
      { key: "b", label: "Back", value: "back" },
    ],
    cancelValue: "back",
  });
  return action === "back"
    ? requestManagerFallback({ ...request, selectedServerId: selected }, requestChoice)
    : { action: action as "toggle" | "reload" | "permissions", serverId: selected };
}

async function commitSelection(
  ports: McpCommandPorts,
  selectedServerIds: readonly string[],
): Promise<void> {
  await ports.recordSelection(selectedServerIds);
  ports.setSelectedServerIds(selectedServerIds);
}

async function useServer(ports: McpCommandPorts, serverId: string): Promise<void> {
  const result = await requestMcpAccess(
    { serverId, reason: "Explicit MCP manager selection" },
    {
      control: ports.control,
      selectedServerIds: ports.selectedServerIds,
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
      commitSelection: (selectedServerIds) => commitSelection(ports, selectedServerIds),
    },
  );
  if (result.status !== "granted") {
    ports.logSystem(
      result.status === "denied"
        ? `MCP server ${serverId} was not selected.\n`
        : `MCP server ${serverId} unavailable: ${result.message}\n`,
    );
  }
}

async function unuseServer(ports: McpCommandPorts, serverId: string): Promise<void> {
  const next = new Set(ports.selectedServerIds());
  next.delete(serverId);
  await commitSelection(ports, [...next].sort());
}

async function managePermissions(ports: McpCommandPorts, serverId: string): Promise<void> {
  const permission = ports.control
    ?.persistentPermissions()
    .find((candidate) => candidate.serverId === serverId);
  if (!permission || (!permission.chatAccess && permission.nativeToolNames.length === 0)) {
    ports.logSystem(`MCP persistent permissions for ${serverId}: none.\n`);
    return;
  }
  const selected = await ports.requestChoice({
    message: `Persistent permissions for ${serverId}`,
    options: [
      ...(permission.chatAccess
        ? [{ key: "s", label: "Revoke persistent server access", value: "server" }]
        : []),
      ...permission.nativeToolNames.map((tool, index) => ({
        key: index < 9 ? String(index + 1) : "",
        label: `Revoke tool: ${tool}`,
        value: `tool:${tool}`,
      })),
      { key: "b", label: "Back", value: "back" },
    ],
    cancelValue: "back",
  });
  if (selected === "server") {
    await ports.control?.revokePersistentPermissions(serverId);
  } else if (selected.startsWith("tool:")) {
    await ports.control?.revokePersistentPermissions(serverId, selected.slice("tool:".length));
  }
}

async function runManager(ports: McpCommandPorts): Promise<void> {
  const { control } = ports;
  if (!control) {
    ports.logSystem("MCP runtime is unavailable.\n");
    return;
  }
  let selectedServerId: string | undefined;
  while (true) {
    const request = managerRequest(control.status(ports.selectedServerIds()), selectedServerId);
    const action = ports.requestManager
      ? await ports.requestManager(request)
      : await requestManagerFallback(request, ports.requestChoice);
    if (action.action === "close") return;
    selectedServerId = action.serverId;
    if (action.action === "reload") {
      try {
        await control.reload(action.serverId);
      } catch (error) {
        ports.logSystem(`MCP reload failed: ${errorMessage(error)}\n`);
      }
    } else if (action.action === "permissions") {
      await managePermissions(ports, action.serverId);
    } else {
      const row = control
        .status(ports.selectedServerIds())
        .find((candidate) => candidate.serverId === action.serverId);
      if (!row) {
        ports.logSystem(`Unknown MCP server: ${action.serverId}.\n`);
      } else if (row.selected) {
        await unuseServer(ports, action.serverId);
      } else {
        await useServer(ports, action.serverId);
      }
    }
  }
}

/** `/mcp` opens the manager; legacy subcommands remain as a compatibility-only surface. */
export async function handleMcpCommand(rawInput: string, ports: McpCommandPorts): Promise<void> {
  const args = rawInput.slice("/mcp".length).trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return runManager(ports);
  const [rawAction, serverId, ...extra] = args;
  const action = rawAction?.toLocaleLowerCase();
  if (!ports.control) {
    ports.logSystem("MCP runtime is unavailable.\n");
    return;
  }
  if (action === "permissions" && !serverId && extra.length === 0) {
    const permissions = ports.control.persistentPermissions();
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
  if (action === "reload" && extra.length === 0) {
    try {
      await ports.control.reload(serverId);
    } catch (error) {
      ports.logSystem(`MCP reload failed: ${errorMessage(error)}\n`);
    }
    return;
  }
  if (action === "use" && serverId && extra.length === 0) return useServer(ports, serverId);
  if (action === "unuse" && serverId && extra.length === 0) return unuseServer(ports, serverId);
  if (action === "revoke" && serverId && extra.length === 0) {
    const [targetServerId, nativeToolName] = serverId.split("/", 2);
    if (targetServerId) {
      await ports.control.revokePersistentPermissions(targetServerId, nativeToolName);
      return;
    }
  }
  ports.logSystem(`${usage()}\n`);
}
