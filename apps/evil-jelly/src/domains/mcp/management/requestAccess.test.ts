import { describe, expect, it, vi } from "vitest";
import { requestMcpAccess } from "./requestAccess";
import type { McpSessionControl, McpSessionStatusRow } from "./sessionControl";

function createHarness(options: { trusted?: boolean; selected?: boolean; approve?: boolean } = {}) {
  let trusted = options.trusted ?? false;
  let selected = options.selected ?? false;
  const row = (selectedServerIds: readonly string[]): McpSessionStatusRow => ({
    serverId: "typescript",
    source: { kind: "workspace" },
    exposure: "explicit",
    selected: selectedServerIds.includes("typescript"),
    routable: trusted && selectedServerIds.includes("typescript"),
    connection: trusted ? "ready" : "untrusted",
    toolCount: trusted ? 4 : 0,
    configFingerprint: "f".repeat(64),
  });
  const control: McpSessionControl = {
    status: (selectedServerIds) => [row(selectedServerIds)],
    reload: vi.fn(async () => undefined),
    grantTrust: vi.fn(async () => {
      trusted = true;
    }),
    waitForServer: vi.fn(async () => ({
      serverId: "typescript",
      configFingerprint: "f".repeat(64),
      status: "ready" as const,
    })),
  };
  const approve = vi.fn(async () => options.approve ?? true);
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
