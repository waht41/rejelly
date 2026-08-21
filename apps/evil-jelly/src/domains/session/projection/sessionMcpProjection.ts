import {
  createSessionMcpState,
  type SessionMcpState,
} from "../../../shared/model/mcp/sessionMcpState";
import type { PreparedSessionReplay } from "./sessionReplay";

/** Recover the latest complete Session MCP state; compaction never participates. */
export function projectSessionMcpState(replay: PreparedSessionReplay): SessionMcpState {
  let selectedServerIds: SessionMcpState["selectedServerIds"] = [];
  let toolGrants: SessionMcpState["toolGrants"] = [];
  for (const event of replay.events) {
    if (event.type === "mcp_selection_changed") {
      selectedServerIds = event.selectedServerIds;
    } else if (event.type === "mcp_tool_grants_changed") {
      toolGrants = event.grants;
    }
  }
  return createSessionMcpState({ selectedServerIds, toolGrants });
}
