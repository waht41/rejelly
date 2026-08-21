import type {
  McpConfigSource,
  McpRequestInput,
  McpRequestResult,
  McpServerRuntimeState,
} from "../contracts";
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
  readonly awaitServer?: (
    serverId: string,
    wait: () => Promise<McpServerRuntimeState>,
  ) => Promise<McpServerRuntimeState>;
}

function unavailable(
  serverId: string,
  code: Extract<McpRequestResult, { status: "unavailable" }>["code"],
  message: string,
): McpRequestResult {
  return { type: "mcp_request_v1", serverId, status: "unavailable", code, message };
}

/** One authorization/recovery path shared by `/mcp use` and the model-facing gateway. */
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

  const alreadyAuthorized =
    row.connection !== "untrusted" &&
    (row.exposure === "always" || row.selected || row.persistentAccess);
  let approvalScope: "session" | "always" | undefined;
  let selectedServerIds = currentSelection;
  if (!alreadyAuthorized) {
    const decision = await ports.approve({
      serverId: row.serverId,
      source: row.source,
      configFingerprint: row.configFingerprint,
      requiresTrust: row.connection === "untrusted",
      ...(input.reason ? { reason: input.reason } : {}),
    });
    if (!decision) {
      return {
        type: "mcp_request_v1",
        serverId: row.serverId,
        status: "denied",
        message: "The user denied MCP access for this session.",
      };
    }
    approvalScope = decision;
  }

  const reloaded = row.connection === "failed";
  try {
    if (approvalScope) {
      if (row.connection === "untrusted") await control.grantTrust(row.serverId);
      selectedServerIds = [...new Set([...ports.selectedServerIds(), row.serverId])].sort();
      if (approvalScope === "always") await control.grantPersistentServerAccess(row.serverId);
      else await ports.commitSelection(selectedServerIds);
    }
    if (reloaded) await control.reload(row.serverId);
    else await control.activateServers([row.serverId]);
    if (ports.awaitServer) {
      await ports.awaitServer(row.serverId, () => control.waitForServer(row.serverId));
    } else {
      await control.waitForServer(row.serverId);
    }
    const finalRow = control
      .status(approvalScope === "always" ? ports.selectedServerIds() : selectedServerIds)
      .find((candidate) => candidate.serverId === row.serverId);
    if (!finalRow) {
      return unavailable(row.serverId, "request_failed", "MCP server disappeared after approval.");
    }
    if (!finalRow.routable) {
      return unavailable(
        row.serverId,
        "request_failed",
        `MCP server did not become callable (${finalRow.connection}${finalRow.failure ? `: ${finalRow.failure.messageExcerpt}` : ""}).`,
      );
    }
    return {
      type: "mcp_request_v1",
      serverId: finalRow.serverId,
      status: "granted",
      selected: finalRow.selected,
      callable: finalRow.routable,
      connection: finalRow.connection,
      configFingerprint: finalRow.configFingerprint,
      ...(reloaded ? { reloaded: true } : {}),
    };
  } catch (error) {
    return unavailable(
      row.serverId,
      "request_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
