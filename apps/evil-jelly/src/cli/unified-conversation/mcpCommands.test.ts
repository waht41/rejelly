import { describe, expect, it, vi } from "vitest";
import { mcpSessionControlStub } from "../../domains/mcp/__tests__/mcpTestFixtures";
import type { McpSessionStatusRow } from "../../domains/mcp/management/sessionControl";
import { handleMcpCommand, isMcpLocalCommand, type McpCommandPorts } from "./mcpCommands";

function row(overrides: Partial<McpSessionStatusRow> = {}): McpSessionStatusRow {
  return {
    serverId: "docs",
    source: { kind: "user" },
    exposure: "explicit",
    selected: false,
    persistentAccess: false,
    routable: false,
    connection: "ready",
    toolCount: 2,
    configFingerprint: "a".repeat(64),
    ...overrides,
  };
}

function ports(overrides: Partial<McpCommandPorts> = {}) {
  const control = mcpSessionControlStub({
    status: vi.fn(() => [row()]),
    reload: vi.fn(async () => undefined),
    grantTrust: vi.fn(async () => undefined),
    grantPersistentServerAccess: vi.fn(async () => undefined),
    grantPersistentToolAccess: vi.fn(async () => undefined),
    isPersistentToolAllowed: vi.fn(() => false),
    persistentPermissions: vi.fn(() => []),
    revokePersistentPermissions: vi.fn(async () => undefined),
    waitForServer: vi.fn(async () => ({
      serverId: "docs",
      configFingerprint: "a".repeat(64),
      status: "ready" as const,
    })),
  });
  return {
    control,
    selectedServerIds: () => [],
    setSelectedServerIds: vi.fn(),
    recordSelection: vi.fn(async () => undefined),
    sessionToolGrants: () => [],
    setSessionToolGrants: vi.fn(),
    recordToolGrants: vi.fn(async () => undefined),
    requestChoice: vi.fn(async () => "cancel"),
    logSystem: vi.fn(),
    ...overrides,
  } satisfies McpCommandPorts;
}

describe("MCP interactive commands", () => {
  it("reserves only the manager and complete legacy grammar as local commands", () => {
    expect(isMcpLocalCommand("/mcp")).toBe(true);
    expect(isMcpLocalCommand("/mcp reload docs")).toBe(true);
    expect(isMcpLocalCommand("/mcp 是如何实现的？")).toBe(false);
    expect(isMcpLocalCommand("/mcp use")).toBe(false);
  });

  it("opens the manager and applies context actions against refreshed status", async () => {
    const requestManager = vi
      .fn()
      .mockResolvedValueOnce({ action: "toggle", serverId: "docs" })
      .mockResolvedValueOnce({ action: "close" });
    const command = ports({ requestManager });

    await handleMcpCommand("/mcp", command);

    expect(requestManager).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ serverId: "docs", connection: "ready" })],
      }),
    );
    expect(command.recordSelection).toHaveBeenCalledWith(["docs"]);
  });

  it("keeps startup in the manager and lets Esc cancel the connection", async () => {
    let selectedServerIds: readonly string[] = [];
    type StartupResult = {
      serverId: string;
      configFingerprint: string;
      status: "failed";
    };
    let resolveStartup!: (result: StartupResult) => void;
    const startup = new Promise<StartupResult>((resolve) => {
      resolveStartup = resolve;
    });
    const requestManager = vi
      .fn()
      .mockResolvedValueOnce({ action: "toggle", serverId: "docs" })
      .mockResolvedValueOnce({ action: "cancel" })
      .mockResolvedValueOnce({ action: "close" });
    const cancelStartup = vi.fn(async () => {
      resolveStartup({
        serverId: "docs",
        configFingerprint: "a".repeat(64),
        status: "failed",
      });
    });
    const command = ports({
      control: mcpSessionControlStub({
        status: () => [
          row({
            selected: selectedServerIds.includes("docs"),
            connection: "pending",
          }),
        ],
        cancelStartup,
        waitForServer: () => startup,
      }),
      selectedServerIds: () => selectedServerIds,
      setSelectedServerIds: (next) => {
        selectedServerIds = next;
      },
      requestManager,
      dismissManager: vi.fn(),
    });

    await handleMcpCommand("/mcp", command);

    expect(requestManager).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        detailServerId: "docs",
        activity: { serverId: "docs", label: "Starting docs…" },
      }),
    );
    expect(cancelStartup).toHaveBeenCalledWith("docs");
    expect(selectedServerIds).toEqual([]);
  });

  it("applies multiple tool approvals through one session and persistent mutation", async () => {
    const grants = ["diagnostics", "find_references"].map((nativeToolName, index) => ({
      serverId: "docs",
      configFingerprint: "a".repeat(64),
      nativeToolName,
      toolSchemaFingerprint: String(index + 1).repeat(64),
    }));
    let sessionToolGrants: typeof grants = [];
    const toolPermissions = vi.fn(() =>
      grants.map((grant) => ({
        nativeToolName: grant.nativeToolName,
        description: grant.nativeToolName,
        grant,
        approval: "ask" as const,
      })),
    );
    const revokePersistentToolPermissions = vi.fn(async () => undefined);
    const requestManager = vi
      .fn()
      .mockResolvedValueOnce({ action: "tools", serverId: "docs" })
      .mockResolvedValueOnce({
        action: "set_tool_approval",
        serverId: "docs",
        tools: grants,
        approval: "session",
      })
      .mockResolvedValueOnce({ action: "close" });
    const command = ports({
      control: mcpSessionControlStub({ toolPermissions, revokePersistentToolPermissions }),
      sessionToolGrants: () => sessionToolGrants,
      setSessionToolGrants: (next) => {
        sessionToolGrants = [...next] as typeof grants;
      },
      requestManager,
    });

    await handleMcpCommand("/mcp", command);

    expect(requestManager).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolPanel: expect.objectContaining({
          serverId: "docs",
          rows: expect.arrayContaining([
            expect.objectContaining({ nativeToolName: "diagnostics", approval: "ask" }),
          ]),
        }),
      }),
    );
    expect(revokePersistentToolPermissions).toHaveBeenCalledOnce();
    expect(revokePersistentToolPermissions).toHaveBeenCalledWith("docs", [
      "diagnostics",
      "find_references",
    ]);
    expect(command.recordToolGrants).toHaveBeenCalledOnce();
    expect(sessionToolGrants).toEqual(grants);
  });

  it("persists a sorted session selection without mutating runtime config", async () => {
    const command = ports({ selectedServerIds: () => ["search"] });
    await handleMcpCommand("/mcp use docs", command);

    expect(command.setSelectedServerIds).toHaveBeenCalledWith(["docs", "search"]);
    expect(command.recordSelection).toHaveBeenCalledWith(["docs", "search"]);
    expect(command.control?.reload).not.toHaveBeenCalled();
  });

  it("grants only the displayed workspace fingerprint after an explicit decision", async () => {
    const command = ports({
      control: mcpSessionControlStub({
        status: () => [row({ source: { kind: "workspace" }, connection: "untrusted" })],
        reload: vi.fn(async () => undefined),
        grantTrust: vi.fn(async () => undefined),
        grantPersistentServerAccess: vi.fn(async () => undefined),
        grantPersistentToolAccess: vi.fn(async () => undefined),
        isPersistentToolAllowed: vi.fn(() => false),
        persistentPermissions: vi.fn(() => []),
        revokePersistentPermissions: vi.fn(async () => undefined),
        waitForServer: vi.fn(async () => ({
          serverId: "docs",
          configFingerprint: "a".repeat(64),
          status: "ready" as const,
        })),
      }),
      requestChoice: vi.fn(async () => "trust"),
    });
    await handleMcpCommand("/mcp use docs", command);

    expect(command.requestChoice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Fingerprint") }),
    );
    expect(command.control?.grantTrust).toHaveBeenCalledWith("docs");
    expect(command.recordSelection).toHaveBeenCalledWith(["docs"]);
  });

  it("re-reads and reconnects through the lifecycle control", async () => {
    const command = ports();
    await handleMcpCommand("/mcp reload docs", command);
    expect(command.control?.reload).toHaveBeenCalledWith("docs");
    expect(command.recordSelection).not.toHaveBeenCalled();
  });

  it("lists and revokes persistent permissions", async () => {
    const command = ports();
    vi.mocked(command.control!.persistentPermissions).mockReturnValue([
      { serverId: "docs", chatAccess: true, nativeToolNames: ["search"] },
    ]);

    await handleMcpCommand("/mcp permissions", command);
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("docs"));

    await handleMcpCommand("/mcp revoke docs/search", command);
    expect(command.control?.revokePersistentPermissions).toHaveBeenCalledWith("docs", "search");
  });
});
