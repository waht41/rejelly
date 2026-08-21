import type { McpToolGrant } from "../../../shared/model/mcp/toolGrant";
import type {
  McpBoundRoute,
  McpConfigSource,
  McpRuntimeFailure,
  McpServerRuntimeState,
  McpServerRuntimeStatus,
} from "../contracts";

export interface McpSessionStatusRow {
  readonly serverId: string;
  readonly source: McpConfigSource;
  readonly exposure: "off" | "explicit" | "always";
  readonly selected: boolean;
  readonly persistentAccess: boolean;
  readonly routable: boolean;
  readonly connection: McpServerRuntimeStatus;
  readonly toolCount: number;
  readonly configFingerprint: string;
  readonly failure?: McpRuntimeFailure;
}

export interface McpToolPermissionRow {
  readonly nativeToolName: string;
  readonly description: string;
  readonly inputSchema: McpBoundRoute["inputSchema"];
  readonly grant: McpToolGrant;
  readonly approval: "ask" | "session" | "always";
  readonly autoApprovedByPolicy: boolean;
}

export interface McpSessionControl {
  status(selectedServerIds: readonly string[]): readonly McpSessionStatusRow[];
  toolPermissions(
    serverId: string,
    sessionGrants: readonly McpToolGrant[],
  ): readonly McpToolPermissionRow[];
  reload(serverId?: string): Promise<void>;
  cancelStartup(serverId: string): Promise<void>;
  activateServers(serverIds: readonly string[]): Promise<void>;
  grantTrust(serverId: string): Promise<void>;
  waitForServer(serverId: string): Promise<McpServerRuntimeState>;
  grantPersistentServerAccess(serverId: string): Promise<void>;
  grantPersistentToolAccess(grants: readonly McpToolGrant[]): Promise<void>;
  isPersistentToolAllowed(route: McpBoundRoute): boolean;
  isToolAutoApproved(route: McpBoundRoute): boolean;
  persistentPermissions(): readonly {
    readonly serverId: string;
    readonly chatAccess: boolean;
    readonly nativeToolNames: readonly string[];
  }[];
  revokePersistentServerAccess(serverId: string): Promise<void>;
  revokePersistentPermissions(serverId: string, nativeToolName?: string): Promise<void>;
  revokePersistentToolPermissions(
    serverId: string,
    nativeToolNames: readonly string[],
  ): Promise<void>;
}

function sourceLabel(source: McpConfigSource): string {
  return source.kind === "dynamic" ? `dynamic:${source.sourceId}` : source.kind;
}

export function formatMcpSessionStatus(rows: readonly McpSessionStatusRow[]): string {
  if (rows.length === 0) return "MCP: no configured servers.\n";
  const lines = [
    "MCP servers:",
    "  server  source  exposure  selected  persistent  routable  connection  tools  detail",
  ];
  for (const row of rows) {
    const detail = row.failure
      ? `${row.failure.code}: ${row.failure.messageExcerpt}`
      : `fingerprint ${row.configFingerprint.slice(0, 12)}`;
    lines.push(
      `  ${row.serverId}  ${sourceLabel(row.source)}  ${row.exposure}  ` +
        `${row.selected ? "yes" : "no"}  ${row.persistentAccess ? "yes" : "no"}  ` +
        `${row.routable ? "yes" : "no"}  ` +
        `${row.connection}  ${row.toolCount}  ${detail}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
