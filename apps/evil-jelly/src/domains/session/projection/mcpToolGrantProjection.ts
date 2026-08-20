import type { McpToolGrant } from "../../../shared/model/mcp/toolGrant";
import type { PreparedSessionReplay } from "./sessionReplay";

/** Recover the latest complete session tool-grant set; compaction never participates. */
export function projectMcpSessionToolGrants(
  replay: PreparedSessionReplay,
): readonly McpToolGrant[] {
  let grants: readonly McpToolGrant[] = [];
  for (const event of replay.events) {
    if (event.type === "mcp_tool_grants_changed") {
      grants = [...event.grants].sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          left.nativeToolName.localeCompare(right.nativeToolName),
      );
    }
  }
  return Object.freeze(grants);
}
