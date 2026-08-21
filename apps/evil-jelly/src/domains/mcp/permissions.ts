import { createHash } from "node:crypto";
import type { McpToolGrant } from "../../shared/model/mcp/toolGrant";
import type { McpBoundRoute } from "./contracts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function fingerprintMcpToolSchema(route: McpBoundRoute): string {
  return createHash("sha256").update(canonicalJson(route.inputSchema)).digest("hex");
}

export function mcpToolGrantForRoute(route: McpBoundRoute): McpToolGrant {
  return Object.freeze({
    serverId: route.identity.serverId,
    configFingerprint: route.configFingerprint,
    nativeToolName: route.identity.nativeToolName,
    toolSchemaFingerprint: fingerprintMcpToolSchema(route),
  });
}

export function mcpToolGrantMatchesRoute(grant: McpToolGrant, route: McpBoundRoute): boolean {
  return (
    grant.serverId === route.identity.serverId &&
    grant.configFingerprint === route.configFingerprint &&
    grant.nativeToolName === route.identity.nativeToolName &&
    grant.toolSchemaFingerprint === fingerprintMcpToolSchema(route)
  );
}
