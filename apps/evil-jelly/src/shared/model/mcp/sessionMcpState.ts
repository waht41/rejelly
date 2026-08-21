import type { McpToolGrant } from "./toolGrant";

/** Storage-independent MCP state owned by one durable Session. */
export interface SessionMcpState {
  readonly selectedServerIds: readonly string[];
  readonly toolGrants: readonly McpToolGrant[];
}

export function createSessionMcpState(input: Partial<SessionMcpState> = {}): SessionMcpState {
  return Object.freeze({
    selectedServerIds: Object.freeze([...(input.selectedServerIds ?? [])].sort()),
    toolGrants: Object.freeze(
      [...(input.toolGrants ?? [])].sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          left.nativeToolName.localeCompare(right.nativeToolName),
      ),
    ),
  });
}

export function emptySessionMcpState(): SessionMcpState {
  return createSessionMcpState();
}
