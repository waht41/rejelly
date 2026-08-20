import {
  evaluateMcpTrust,
  projectMcpServerForDisplay,
  resolveMcpDesiredConfig,
  resolveMcpSettingsLayers,
} from "../../../domains/mcp/configuration/configuration";
import type { McpDesiredConfig, McpDesiredServer } from "../../../domains/mcp/contracts";
import { getSettings, type ResolvedSettings } from "../../../shared/configuration/settings";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import type { McpManagementCommand, McpReadScope } from "./args";
import {
  addMcpServerSettings,
  readMcpSettingsScope,
  removeMcpServerSettings,
  setMcpServerEnabled,
} from "./settingsRepository";

function configForScope(scope: McpReadScope, workspaceRoot: string): McpDesiredConfig {
  if (scope === "effective") return effectiveMcpConfig(getSettings());
  const settings = readMcpSettingsScope(scope, workspaceRoot);
  return resolveMcpDesiredConfig(scope === "user" ? { user: settings } : { workspace: settings });
}

function effectiveMcpConfig(settings: ResolvedSettings): McpDesiredConfig {
  return resolveMcpSettingsLayers(settings.mcp);
}

function statusProjection(server: McpDesiredServer): object {
  const trust = evaluateMcpTrust(server, []);
  return {
    id: server.id,
    source: server.source,
    enabled: server.definition.enabled,
    transport: server.definition.transport.type,
    chat: server.definition.use.chat.exposure,
    audit: server.definition.use.audit.exposure,
    trust: trust.trusted ? "trusted" : "approval_required",
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runMcpCommand(command: McpManagementCommand): Promise<void> {
  const workspaceRoot = getWorkspaceFsPolicy().getRoot();
  // Validate both settings layers before any edit. Management never silently repairs or writes
  // around a malformed configuration file.
  effectiveMcpConfig(getSettings());
  switch (command.action) {
    case "list": {
      const config = configForScope(command.scope, workspaceRoot);
      printJson({
        type: "mcp_server_list_v1",
        scope: command.scope,
        servers: config.servers.map(statusProjection),
      });
      return;
    }
    case "get": {
      const server = configForScope(command.scope, workspaceRoot).servers.find(
        (candidate) => candidate.id === command.serverId,
      );
      if (!server) {
        throw new Error(`MCP server "${command.serverId}" was not found in ${command.scope}.`);
      }
      const trust = evaluateMcpTrust(server, []);
      printJson({
        type: "mcp_server_v1",
        scope: command.scope,
        server: projectMcpServerForDisplay(server),
        trust: trust.trusted ? "trusted" : "approval_required",
      });
      return;
    }
    case "add": {
      const filePath = addMcpServerSettings(
        command.scope,
        workspaceRoot,
        command.serverId,
        command.settings,
      );
      console.log(`Added MCP server "${command.serverId}" to ${command.scope}: ${filePath}`);
      return;
    }
    case "remove": {
      const filePath = removeMcpServerSettings(command.scope, workspaceRoot, command.serverId);
      console.log(`Removed MCP server "${command.serverId}" from ${command.scope}: ${filePath}`);
      return;
    }
    case "enable":
    case "disable": {
      const enabled = command.action === "enable";
      const filePath = setMcpServerEnabled(command.scope, workspaceRoot, command.serverId, enabled);
      console.log(
        `${enabled ? "Enabled" : "Disabled"} MCP server "${command.serverId}" in ${command.scope}: ${filePath}`,
      );
      return;
    }
  }
}
