/** A version-sensitive authorization for one native MCP tool. */
export interface McpToolGrant {
  readonly serverId: string;
  readonly configFingerprint: string;
  readonly nativeToolName: string;
  readonly toolSchemaFingerprint: string;
}
