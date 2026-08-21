import { requestMcpAccess } from "../../domains/mcp/management/requestAccess";
import type {
  McpSessionControl,
  McpSessionStatusRow,
  McpToolPermissionRow,
} from "../../domains/mcp/management/sessionControl";
import type {
  McpManagerAction,
  McpManagerRequest,
  PromptChoiceRequest,
} from "../../shared/host/inputBindings";
import type { McpToolGrant } from "../../shared/model/mcp/toolGrant";

export interface McpCommandPorts {
  readonly control?: McpSessionControl;
  selectedServerIds(): readonly string[];
  setSelectedServerIds(selectedServerIds: readonly string[]): void;
  recordSelection(selectedServerIds: readonly string[]): Promise<void>;
  sessionToolGrants(): readonly McpToolGrant[];
  setSessionToolGrants(grants: readonly McpToolGrant[]): void;
  recordToolGrants(grants: readonly McpToolGrant[]): Promise<void>;
  requestChoice(request: PromptChoiceRequest): Promise<string>;
  requestManager?: (request: McpManagerRequest) => Promise<McpManagerAction>;
  dismissManager?: () => void;
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
  detailServerId?: string,
  activity?: McpManagerRequest["activity"],
  toolPanel?: McpManagerRequest["toolPanel"],
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
    ...(detailServerId ? { detailServerId } : {}),
    ...(activity ? { activity } : {}),
    ...(toolPanel ? { toolPanel } : {}),
  };
}

function toolPanel(
  serverId: string,
  rows: readonly McpToolPermissionRow[],
): NonNullable<McpManagerRequest["toolPanel"]> {
  return {
    serverId,
    rows: rows.map((row) => ({
      nativeToolName: row.nativeToolName,
      description: row.description,
      inputSchema: row.inputSchema,
      approval: row.approval,
      configFingerprint: row.grant.configFingerprint,
      toolSchemaFingerprint: row.grant.toolSchemaFingerprint,
    })),
  };
}

async function requestManagerFallback(
  request: McpManagerRequest,
  requestChoice: McpCommandPorts["requestChoice"],
): Promise<McpManagerAction> {
  if (request.toolPanel) {
    const selectedTool = await requestChoice({
      message: `MCP ${request.toolPanel.serverId} tools`,
      options: [
        ...request.toolPanel.rows.map((row, index) => ({
          key: index < 9 ? String(index + 1) : "",
          label: `${row.nativeToolName} · ${row.approval}`,
          value: row.nativeToolName,
        })),
        { key: "b", label: "Back", value: "" },
      ],
      cancelValue: "",
    });
    const row = request.toolPanel.rows.find(
      (candidate) => candidate.nativeToolName === selectedTool,
    );
    if (!row) return { action: "refresh" };
    const approval = await requestChoice({
      message: `Approval for ${row.nativeToolName}`,
      options: [
        { key: "s", label: "Allow for this session", value: "session" },
        { key: "a", label: "Always allow", value: "always" },
        { key: "r", label: "Revoke approval", value: "ask" },
        { key: "b", label: "Back", value: "back" },
      ],
      cancelValue: "back",
    });
    if (approval === "back") return { action: "refresh" };
    return {
      action: "set_tool_approval",
      serverId: request.toolPanel.serverId,
      tools: [row],
      approval: approval as "ask" | "session" | "always",
    };
  }
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
      { key: "t", label: "Tools & approvals", value: "tools" },
      { key: "p", label: "Persistent permissions", value: "permissions" },
      { key: "b", label: "Back", value: "back" },
    ],
    cancelValue: "back",
  });
  return action === "back"
    ? requestManagerFallback({ ...request, selectedServerId: selected }, requestChoice)
    : { action: action as "toggle" | "reload" | "permissions" | "tools", serverId: selected };
}

async function commitSelection(
  ports: McpCommandPorts,
  selectedServerIds: readonly string[],
): Promise<void> {
  await ports.recordSelection(selectedServerIds);
  ports.setSelectedServerIds(selectedServerIds);
}

async function commitToolGrants(
  ports: McpCommandPorts,
  grants: readonly McpToolGrant[],
): Promise<void> {
  await ports.recordToolGrants(grants);
  ports.setSessionToolGrants(grants);
}

async function setToolApproval(
  ports: McpCommandPorts,
  action: Extract<McpManagerAction, { action: "set_tool_approval" }>,
): Promise<void> {
  const { control } = ports;
  if (!control) return;
  const currentRows = control.toolPermissions(action.serverId, ports.sessionToolGrants());
  const requested = new Map(action.tools.map((tool) => [tool.nativeToolName, tool]));
  const validRows = currentRows.filter((row) => {
    const expected = requested.get(row.nativeToolName);
    return (
      expected?.configFingerprint === row.grant.configFingerprint &&
      expected.toolSchemaFingerprint === row.grant.toolSchemaFingerprint
    );
  });
  const validNames = new Set(validRows.map((row) => row.nativeToolName));
  const grants = validRows.map((row) => row.grant);
  if (action.approval === "always") {
    await control.grantPersistentToolAccess(grants);
  } else {
    await control.revokePersistentToolPermissions(action.serverId, [...validNames]);
  }

  const currentSessionGrants = ports.sessionToolGrants();
  const nextSessionGrants = currentSessionGrants.filter(
    (grant) => grant.serverId !== action.serverId || !validNames.has(grant.nativeToolName),
  );
  if (action.approval === "session") nextSessionGrants.push(...grants);
  if (
    nextSessionGrants.length !== currentSessionGrants.length ||
    nextSessionGrants.some((grant, index) => grant !== currentSessionGrants[index])
  ) {
    await commitToolGrants(ports, nextSessionGrants);
  }

  const skipped = requested.size - validRows.length;
  if (skipped > 0) {
    ports.logSystem(
      `MCP tool permissions: ${validRows.length} updated, ${skipped} skipped (catalog changed).\n`,
    );
  }
}

async function awaitServerInManager(
  ports: McpCommandPorts,
  serverId: string,
  wait: () => ReturnType<McpSessionControl["waitForServer"]>,
) {
  const { control, requestManager, dismissManager } = ports;
  const connection = control
    ?.status(ports.selectedServerIds())
    .find((row) => row.serverId === serverId)?.connection;
  if (!control || !requestManager || !dismissManager || connection !== "pending") return wait();

  const manager = requestManager(
    managerRequest(control.status(ports.selectedServerIds()), serverId, serverId, {
      serverId,
      label: `Starting ${serverId}…`,
    }),
  );
  const startup = Promise.resolve().then(wait);
  const winner = await Promise.race([
    startup.then((state) => ({ type: "complete" as const, state })),
    manager.then((action) => ({ type: "action" as const, action })),
  ]);
  if (winner.type === "complete") {
    dismissManager();
    await manager;
    return winner.state;
  }
  if (winner.action.action === "cancel") {
    await control.cancelStartup(serverId);
    await unuseServer(ports, serverId);
    await startup;
    throw new Error(`MCP startup cancelled by user: ${serverId}`);
  }
  return startup;
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
      awaitServer: (targetServerId, wait) => awaitServerInManager(ports, targetServerId, wait),
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
  if (permission?.chatAccess) await ports.control?.revokePersistentServerAccess(serverId);
}

async function runManager(ports: McpCommandPorts): Promise<void> {
  const { control } = ports;
  if (!control) {
    ports.logSystem("MCP runtime is unavailable.\n");
    return;
  }
  let selectedServerId: string | undefined;
  let detailServerId: string | undefined;
  let toolServerId: string | undefined;
  while (true) {
    const tools = toolServerId
      ? toolPanel(toolServerId, control.toolPermissions(toolServerId, ports.sessionToolGrants()))
      : undefined;
    const request = managerRequest(
      control.status(ports.selectedServerIds()),
      selectedServerId,
      detailServerId,
      undefined,
      tools,
    );
    const action = ports.requestManager
      ? await ports.requestManager(request)
      : await requestManagerFallback(request, ports.requestChoice);
    if (action.action === "close") return;
    if (!("serverId" in action)) continue;
    selectedServerId = action.serverId;
    detailServerId = action.serverId;
    if (action.action === "tools") {
      toolServerId = action.serverId;
    } else if (action.action === "set_tool_approval") {
      toolServerId = action.serverId;
      await setToolApproval(ports, action);
    } else if (action.action === "reload") {
      toolServerId = undefined;
      try {
        await control.reload(action.serverId);
      } catch (error) {
        ports.logSystem(`MCP reload failed: ${errorMessage(error)}\n`);
      }
    } else if (action.action === "permissions") {
      toolServerId = undefined;
      await managePermissions(ports, action.serverId);
    } else {
      toolServerId = undefined;
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
