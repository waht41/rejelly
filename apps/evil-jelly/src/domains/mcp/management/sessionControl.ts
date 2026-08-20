import type { McpConfigSource, McpServerRuntimeStatus } from "../contracts";

export interface McpSessionStatusRow {
  readonly serverId: string;
  readonly source: McpConfigSource;
  readonly exposure: "off" | "explicit" | "always";
  readonly selected: boolean;
  readonly routable: boolean;
  readonly connection: McpServerRuntimeStatus;
  readonly toolCount: number;
  readonly configFingerprint: string;
  readonly error?: string;
}

export interface McpSessionControl {
  status(selectedServerIds: readonly string[]): readonly McpSessionStatusRow[];
  reload(serverId?: string): Promise<void>;
  grantTrust(serverId: string): Promise<void>;
}

function sourceLabel(source: McpConfigSource): string {
  return source.kind === "dynamic" ? `dynamic:${source.sourceId}` : source.kind;
}

export function formatMcpSessionStatus(rows: readonly McpSessionStatusRow[]): string {
  if (rows.length === 0) return "MCP: no configured servers.\n";
  const lines = [
    "MCP servers:",
    "  server  source  exposure  selected  routable  connection  tools  detail",
  ];
  for (const row of rows) {
    const detail = row.error
      ? row.error.replace(/\s+/g, " ").trim()
      : `fingerprint ${row.configFingerprint.slice(0, 12)}`;
    lines.push(
      `  ${row.serverId}  ${sourceLabel(row.source)}  ${row.exposure}  ` +
        `${row.selected ? "yes" : "no"}  ${row.routable ? "yes" : "no"}  ` +
        `${row.connection}  ${row.toolCount}  ${detail}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
