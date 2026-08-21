import { resolveMcpSettingsLayers } from "../../domains/mcp/configuration/configuration";
import {
  isMcpToolAllowed,
  type McpBoundRoute,
  type McpDesiredConfig,
  type McpDesiredServer,
} from "../../domains/mcp/contracts";
import type { McpDispatchBindingFactory } from "../../domains/mcp/gateway/dispatch";
import type {
  McpSessionControl,
  McpSessionStatusRow,
} from "../../domains/mcp/management/sessionControl";
import {
  createMcpDispatchBindingFactory,
  createMcpRuntimeProviders,
} from "../../domains/mcp/mcpServerKit";
import { fingerprintMcpToolSchema } from "../../domains/mcp/permissions";
import { McpRuntimeManager } from "../../domains/mcp/runtime/runtimeManager";
import { SdkMcpRuntimeConnector } from "../../domains/mcp/runtime/sdkConnector";
import { getEnvironmentValue } from "../../shared/configuration/env";
import { getSettings, invalidateSettingsCache } from "../../shared/configuration/settings";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import {
  grantMcpPersistentServerAccess,
  grantMcpPersistentToolAccess,
  grantMcpWorkspaceTrust,
  readMcpPersistentPermissions,
  readMcpTrustGrants,
  revokeMcpPersistentPermissions,
} from "../../shared/mcp/trustRepository";
export interface McpChatRuntime {
  readonly providers: Record<string, unknown>;
  readonly bindingFactory: McpDispatchBindingFactory;
  readonly sessionControl: McpSessionControl;
  readonly resolveUserInput: (serverId: string) => {
    status: "selected" | "unavailable" | "disabled" | "untrusted";
    configFingerprint?: string;
  };
  dispose(): Promise<void>;
}

export async function createMcpChatRuntime(options: {
  readonly workspaceRoot: string;
  readonly bindings: EvilJellyBindings;
  readonly dynamicServers?: readonly McpDesiredServer[];
}): Promise<McpChatRuntime> {
  const { workspaceRoot, bindings } = options;
  const resolveDesired = (): McpDesiredConfig =>
    resolveMcpSettingsLayers(getSettings().mcp, options.dynamicServers);
  const manager = new McpRuntimeManager(
    new SdkMcpRuntimeConnector({
      workspaceRoot,
      resolveEnvironment: getEnvironmentValue,
    }),
  );
  let desired = resolveDesired();
  let trustGrants = readMcpTrustGrants(workspaceRoot);
  let persistentPermissions = readMcpPersistentPermissions(workspaceRoot);
  await manager.reconcile(desired, trustGrants);

  const currentPersistentPermission = (serverId: string) => {
    const runtime = manager
      .getSnapshot()
      .servers.find((candidate) => candidate.serverId === serverId);
    return persistentPermissions.find(
      (permission) =>
        permission.serverId === serverId &&
        permission.configFingerprint === runtime?.configFingerprint,
    );
  };
  const persistentServerIds = () =>
    persistentPermissions
      .filter(
        (permission) => permission.chatAccess && currentPersistentPermission(permission.serverId),
      )
      .map((permission) => permission.serverId);
  const publishInventory = () =>
    bindings.setAvailableMcpServers?.(
      desired.servers
        .filter((server) => server.definition.use.chat.exposure !== "off")
        .map((server) => ({ serverId: server.id })),
    );

  const sessionControl: McpSessionControl = {
    status: (selectedServerIds): readonly McpSessionStatusRow[] => {
      const selected = new Set(selectedServerIds);
      const runtimeById = new Map(
        manager.getSnapshot().servers.map((server) => [server.serverId, server]),
      );
      return desired.servers.map((server) => {
        const runtime = runtimeById.get(server.id);
        const exposure = server.definition.use.chat.exposure;
        const isSelected = selected.has(server.id);
        const persistentAccess = currentPersistentPermission(server.id)?.chatAccess ?? false;
        return {
          serverId: server.id,
          source: server.source,
          exposure,
          selected: isSelected,
          persistentAccess,
          routable:
            runtime?.status === "ready" &&
            exposure !== "off" &&
            (exposure === "always" || persistentAccess || isSelected),
          connection: runtime?.status ?? "failed",
          toolCount:
            manager
              .getCatalog(server.id)
              ?.tools.filter((tool) => isMcpToolAllowed(server.definition, "chat", tool.name))
              .length ?? 0,
          configFingerprint: runtime?.configFingerprint ?? "unavailable",
          ...(runtime?.error ? { error: runtime.error } : {}),
        };
      });
    },
    reload: async (serverId) => {
      invalidateSettingsCache();
      desired = resolveDesired();
      trustGrants = readMcpTrustGrants(workspaceRoot);
      persistentPermissions = readMcpPersistentPermissions(workspaceRoot);
      await manager.reconcile(desired, trustGrants);
      publishInventory();
      await manager.reload(serverId);
    },
    cancelStartup: async (serverId) => {
      await manager.cancelStartup(serverId);
    },
    grantTrust: async (serverId) => {
      const server = desired.servers.find((candidate) => candidate.id === serverId);
      const runtime = manager
        .getSnapshot()
        .servers.find((candidate) => candidate.serverId === serverId);
      if (!server || !runtime) throw new Error(`Unknown MCP server: ${serverId}`);
      if (server.source.kind !== "workspace") return;
      grantMcpWorkspaceTrust(workspaceRoot, {
        serverId,
        configFingerprint: runtime.configFingerprint,
      });
      trustGrants = readMcpTrustGrants(workspaceRoot);
      await manager.reconcile(desired, trustGrants);
    },
    waitForServer: (serverId) => manager.waitForServer(serverId),
    grantPersistentServerAccess: async (serverId) => {
      const runtime = manager
        .getSnapshot()
        .servers.find((candidate) => candidate.serverId === serverId);
      if (!runtime) throw new Error(`Unknown MCP server: ${serverId}`);
      grantMcpPersistentServerAccess(workspaceRoot, {
        serverId,
        configFingerprint: runtime.configFingerprint,
      });
      persistentPermissions = readMcpPersistentPermissions(workspaceRoot);
    },
    grantPersistentToolAccess: async (grant) => {
      grantMcpPersistentToolAccess(workspaceRoot, grant);
      persistentPermissions = readMcpPersistentPermissions(workspaceRoot);
    },
    isPersistentToolAllowed: (route: McpBoundRoute) => {
      const permission = currentPersistentPermission(route.identity.serverId);
      return (
        permission?.tools.some(
          (tool) =>
            tool.nativeToolName === route.identity.nativeToolName &&
            tool.toolSchemaFingerprint === fingerprintMcpToolSchema(route),
        ) ?? false
      );
    },
    persistentPermissions: () =>
      persistentPermissions.map((permission) => ({
        serverId: permission.serverId,
        chatAccess: permission.chatAccess,
        nativeToolNames: permission.tools.map((tool) => tool.nativeToolName),
      })),
    revokePersistentPermissions: async (serverId, nativeToolName) => {
      revokeMcpPersistentPermissions(workspaceRoot, serverId, nativeToolName);
      persistentPermissions = readMcpPersistentPermissions(workspaceRoot);
    },
  };

  publishInventory();
  return Object.freeze({
    providers: createMcpRuntimeProviders(manager),
    bindingFactory: createMcpDispatchBindingFactory(manager, bindings.confirmTool, {
      persistentServerIds,
    }),
    sessionControl,
    resolveUserInput: (serverId: string) => {
      const state = manager.getSnapshot().servers.find((server) => server.serverId === serverId);
      if (!state) return { status: "unavailable" as const };
      const status =
        state.status === "disabled"
          ? ("disabled" as const)
          : state.status === "untrusted"
            ? ("untrusted" as const)
            : ("selected" as const);
      return { status, configFingerprint: state.configFingerprint };
    },
    dispose: () => manager.dispose(),
  });
}
