import type { McpConfigSource, McpRequestInput, McpRequestResult } from "../contracts";
import type { McpSessionControl } from "./sessionControl";

export interface McpAccessApprovalProposal {
  readonly serverId: string;
  readonly source: McpConfigSource;
  readonly configFingerprint: string;
  readonly requiresTrust: boolean;
  readonly reason?: string;
}

export interface McpAccessRequestPorts {
  readonly control?: McpSessionControl;
  readonly selectedServerIds: () => readonly string[];
  readonly approve: (proposal: McpAccessApprovalProposal) => Promise<"session" | "always" | false>;
  readonly commitSelection: (selectedServerIds: readonly string[]) => Promise<void>;
}

function unavailable(
  serverId: string,
  code: Extract<McpRequestResult, { status: "unavailable" }>["code"],
  message: string,
): McpRequestResult {
  return { type: "mcp_request_v1", serverId, status: "unavailable", code, message };
}

/** One mutation path shared by `/mcp use` and the model-facing request gateway. */
export async function requestMcpAccess(
  input: McpRequestInput,
  ports: McpAccessRequestPorts,
): Promise<McpRequestResult> {
  const { control } = ports;
  if (!control) {
    return unavailable(input.serverId, "runtime_unavailable", "MCP runtime is unavailable.");
  }
  const currentSelection = ports.selectedServerIds();
  const row = control
    .status(currentSelection)
    .find((candidate) => candidate.serverId === input.serverId);
  if (!row) {
    return unavailable(input.serverId, "not_configured", "MCP server is not configured.");
  }
  if (row.exposure === "off" || row.connection === "disabled") {
    return unavailable(input.serverId, "disabled", "MCP server is disabled for chat.");
  }
  if (row.routable) {
    return {
      type: "mcp_request_v1",
      serverId: row.serverId,
      status: "granted",
      selected: row.selected,
      callable: true,
      connection: row.connection,
      configFingerprint: row.configFingerprint,
    };
  }

  const approvalScope = await ports.approve({
    serverId: row.serverId,
    source: row.source,
    configFingerprint: row.configFingerprint,
    requiresTrust: row.connection === "untrusted",
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (!approvalScope) {
    return {
      type: "mcp_request_v1",
      serverId: row.serverId,
      status: "denied",
      message: "The user denied MCP access for this session.",
    };
  }

  try {
    if (row.connection === "untrusted") await control.grantTrust(row.serverId);
    const selectedServerIds = [...new Set([...ports.selectedServerIds(), row.serverId])].sort();
    if (approvalScope === "always") await control.grantPersistentServerAccess(row.serverId);
    else await ports.commitSelection(selectedServerIds);
    await control.waitForServer(row.serverId);
    const finalRow = control
      .status(approvalScope === "always" ? ports.selectedServerIds() : selectedServerIds)
      .find((candidate) => candidate.serverId === row.serverId);
    if (!finalRow) {
      return unavailable(row.serverId, "request_failed", "MCP server disappeared after approval.");
    }
    return {
      type: "mcp_request_v1",
      serverId: finalRow.serverId,
      status: "granted",
      selected: finalRow.selected,
      callable: finalRow.routable,
      connection: finalRow.connection,
      configFingerprint: finalRow.configFingerprint,
    };
  } catch (error) {
    return unavailable(
      row.serverId,
      "request_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
