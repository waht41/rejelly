import type { McpBoundRoute } from "../contracts";
import type { McpSessionControl } from "../management/sessionControl";

export function mcpBoundRouteFixture(overrides: Partial<McpBoundRoute> = {}): McpBoundRoute {
  return {
    identity: { serverId: "docs", nativeToolName: "read" },
    description: "Read docs",
    inputSchema: { type: "object" },
    configFingerprint: "config-v1",
    catalogRevision: "catalog-v1",
    ...overrides,
  };
}

export function mcpSessionControlStub(
  overrides: Partial<McpSessionControl> = {},
): McpSessionControl {
  return {
    status: () => [],
    toolPermissions: () => [],
    reload: async () => undefined,
    cancelStartup: async () => undefined,
    grantTrust: async () => undefined,
    waitForServer: async (serverId) => ({
      serverId,
      configFingerprint: "config-v1",
      status: "ready",
    }),
    grantPersistentServerAccess: async () => undefined,
    grantPersistentToolAccess: async () => undefined,
    isPersistentToolAllowed: () => false,
    persistentPermissions: () => [],
    revokePersistentServerAccess: async () => undefined,
    revokePersistentPermissions: async () => undefined,
    revokePersistentToolPermissions: async () => undefined,
    ...overrides,
  };
}
