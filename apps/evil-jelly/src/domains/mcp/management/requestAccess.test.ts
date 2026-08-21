import { describe, expect, it, vi } from "vitest";
import { mcpSessionControlStub } from "../__tests__/mcpTestFixtures";
import { requestMcpAccess } from "./requestAccess";
import type { McpSessionStatusRow } from "./sessionControl";

function createHarness(
  options: {
    trusted?: boolean;
    selected?: boolean;
    persistent?: boolean;
    approve?: "session" | "always" | false;
  } = {},
) {
  let trusted = options.trusted ?? false;
  let selected = options.selected ?? false;
  let persistent = options.persistent ?? false;
  const row = (selectedServerIds: readonly string[]): McpSessionStatusRow => ({
    serverId: "typescript",
    source: { kind: "workspace" },
    exposure: "explicit",
    selected: selectedServerIds.includes("typescript"),
    persistentAccess: persistent,
    routable: trusted && (persistent || selectedServerIds.includes("typescript")),
    connection: trusted ? "ready" : "untrusted",
    toolCount: trusted ? 4 : 0,
    configFingerprint: "f".repeat(64),
  });
  const control = mcpSessionControlStub({
    status: (selectedServerIds) => [row(selectedServerIds)],
    reload: vi.fn(async () => undefined),
    grantTrust: vi.fn(async () => {
      trusted = true;
    }),
    grantPersistentServerAccess: vi.fn(async () => {
      persistent = true;
    }),
    grantPersistentToolAccess: vi.fn(async () => undefined),
    isPersistentToolAllowed: vi.fn(() => false),
    persistentPermissions: vi.fn(() => []),
    revokePersistentPermissions: vi.fn(async () => undefined),
    waitForServer: vi.fn(async () => ({
      serverId: "typescript",
      configFingerprint: "f".repeat(64),
      status: "ready" as const,
    })),
  });
  const approve = vi.fn(async () => options.approve ?? "session");
  const commitSelection = vi.fn(async (serverIds: readonly string[]) => {
    selected = serverIds.includes("typescript");
  });
  return {
    control,
    approve,
    commitSelection,
    selectedServerIds: () => (selected ? ["typescript"] : []),
  };
}

describe("MCP access requests", () => {
  it("approves the current fingerprint, trusts, selects, and returns a callable server", async () => {
    const harness = createHarness();

    const result = await requestMcpAccess(
      { serverId: "typescript", reason: "Find references" },
      harness,
    );

    expect(harness.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "typescript",
        requiresTrust: true,
        reason: "Find references",
      }),
    );
    expect(harness.control.grantTrust).toHaveBeenCalledWith("typescript");
    expect(harness.commitSelection).toHaveBeenCalledWith(["typescript"]);
    expect(result).toMatchObject({ status: "granted", selected: true, callable: true });
  });

  it("does not mutate selection when the user denies access", async () => {
    const harness = createHarness({ approve: false });

    await expect(requestMcpAccess({ serverId: "typescript" }, harness)).resolves.toMatchObject({
      status: "denied",
    });
    expect(harness.control.grantTrust).not.toHaveBeenCalled();
    expect(harness.commitSelection).not.toHaveBeenCalled();
  });

  it("persists workspace access without adding a session selection", async () => {
    const harness = createHarness({ approve: "always" });

    await expect(requestMcpAccess({ serverId: "typescript" }, harness)).resolves.toMatchObject({
      status: "granted",
      callable: true,
    });
    expect(harness.control.grantPersistentServerAccess).toHaveBeenCalledWith("typescript");
    expect(harness.commitSelection).not.toHaveBeenCalled();
  });

  it("is idempotent when the server is already routable", async () => {
    const harness = createHarness({ trusted: true, selected: true });

    await expect(requestMcpAccess({ serverId: "typescript" }, harness)).resolves.toMatchObject({
      status: "granted",
      callable: true,
    });
    expect(harness.approve).not.toHaveBeenCalled();
    expect(harness.commitSelection).not.toHaveBeenCalled();
  });
});
