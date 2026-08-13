import { describe, expect, it, vi } from "vitest";
import { createInteractiveCommandHandler, type InteractiveCommandPorts } from "./localCommands";

function createPorts(overrides: Partial<InteractiveCommandPorts> = {}): InteractiveCommandPorts {
  return {
    applyMode: () => null,
    listTools: () => [],
    getLastAssistantMessage: () => undefined,
    openTranscript: vi.fn(),
    copyText: vi.fn(async () => {}),
    logSystem: vi.fn(),
    ...overrides,
  };
}

describe("interactive commands", () => {
  it("leaves application commands unclaimed", () => {
    const ports = createPorts();
    expect(createInteractiveCommandHandler(ports)("/resume")).toBe(false);
    expect(ports.logSystem).not.toHaveBeenCalled();
  });

  it("reports mode changes supplied by the host adapter", () => {
    const ports = createPorts({
      applyMode: () => ({ label: "auto-run", hint: "writes auto" }),
    });
    expect(createInteractiveCommandHandler(ports)("/mode auto")).toBe(true);
    expect(ports.logSystem).toHaveBeenCalledWith("Mode → auto-run (writes auto)");
  });

  it("opens the transcript or prints one requested tool", () => {
    const ports = createPorts({
      listTools: () => [
        {
          ordinal: 2,
          toolName: "read_file",
          summary: "Read config",
          args: '{"path":"config.ts"}',
          fullResult: "contents",
        },
      ],
    });
    const handle = createInteractiveCommandHandler(ports);

    expect(handle("/expand-tool")).toBe(true);
    expect(ports.openTranscript).toHaveBeenCalledOnce();
    expect(handle("/expand-tool #2")).toBe(true);
    expect(ports.logSystem).toHaveBeenCalledWith(expect.stringContaining("#2 read_file"));
  });

  it("copies the last assistant message", async () => {
    const copyText = vi.fn(async () => {});
    const ports = createPorts({ getLastAssistantMessage: () => "raw markdown", copyText });

    expect(createInteractiveCommandHandler(ports)("/copy-last")).toBe(true);
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("raw markdown"));
    expect(ports.logSystem).toHaveBeenCalledWith("Copied last assistant message to clipboard.");
  });
});
