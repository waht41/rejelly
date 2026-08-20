import { describe, expect, it, vi } from "vitest";
import type {
  McpSessionControl,
  McpSessionStatusRow,
} from "../../domains/mcp/management/sessionControl";
import { handleMcpCommand, type McpCommandPorts } from "./mcpCommands";

function row(overrides: Partial<McpSessionStatusRow> = {}): McpSessionStatusRow {
  return {
    serverId: "docs",
    source: { kind: "user" },
    exposure: "explicit",
    selected: false,
    routable: false,
    connection: "ready",
    toolCount: 2,
    configFingerprint: "a".repeat(64),
    ...overrides,
  };
}

function ports(overrides: Partial<McpCommandPorts> = {}) {
  const control: McpSessionControl = {
    status: vi.fn(() => [row()]),
    reload: vi.fn(async () => undefined),
    grantTrust: vi.fn(async () => undefined),
    waitForServer: vi.fn(async () => ({
      serverId: "docs",
      configFingerprint: "a".repeat(64),
      status: "ready" as const,
    })),
  };
  return {
    control,
    selectedServerIds: [],
    setSelectedServerIds: vi.fn(),
    recordSelection: vi.fn(async () => undefined),
    requestChoice: vi.fn(async () => "cancel"),
    logSystem: vi.fn(),
    ...overrides,
  } satisfies McpCommandPorts;
}

describe("MCP interactive commands", () => {
  it("persists a sorted session selection without mutating runtime config", async () => {
    const command = ports({ selectedServerIds: ["search"] });
    await handleMcpCommand("/mcp use docs", command);

    expect(command.setSelectedServerIds).toHaveBeenCalledWith(["docs", "search"]);
    expect(command.recordSelection).toHaveBeenCalledWith(["docs", "search"]);
    expect(command.control?.reload).not.toHaveBeenCalled();
  });

  it("grants only the displayed workspace fingerprint after an explicit decision", async () => {
    const command = ports({
      control: {
        status: () => [row({ source: { kind: "workspace" }, connection: "untrusted" })],
        reload: vi.fn(async () => undefined),
        grantTrust: vi.fn(async () => undefined),
        waitForServer: vi.fn(async () => ({
          serverId: "docs",
          configFingerprint: "a".repeat(64),
          status: "ready" as const,
        })),
      },
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
});
