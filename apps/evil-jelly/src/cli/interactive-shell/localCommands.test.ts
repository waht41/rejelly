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

  it("prints the current output of a running tool", () => {
    const ports = createPorts({
      listTools: () => [
        {
          ordinal: 3,
          status: "running",
          toolName: "run_command",
          summary: "Run tests",
          args: '{"command":"pnpm test"}',
          fullResult: "compiling\ntesting",
          lineCount: 40,
          retainedLineCount: 2,
          droppedLineCount: 38,
        },
      ],
    });

    expect(createInteractiveCommandHandler(ports)("/expand-tool #3")).toBe(true);
    expect(ports.logSystem).toHaveBeenCalledWith(
      expect.stringContaining("#3 run_command (running)"),
    );
    expect(ports.logSystem).toHaveBeenCalledWith(
      expect.stringContaining("Live output · 40 lines seen · retaining latest 2"),
    );
    expect(ports.logSystem).toHaveBeenCalledWith(
      expect.stringContaining("… 38 earlier lines omitted"),
    );
  });

  it("labels an expanded proposal that was not applied", () => {
    const ports = createPorts({
      listTools: () => [
        {
          ordinal: 4,
          toolName: "edit_file",
          summary: "Edit config",
          detail: {
            type: "diff",
            text: "--- a.ts\n+++ a.ts\n@@\n-old\n+new",
            phase: "proposed",
          },
          fullResult: "Write denied by user; files unchanged.",
        },
      ],
    });

    expect(createInteractiveCommandHandler(ports)("/expand-tool #4")).toBe(true);
    expect(ports.logSystem).toHaveBeenCalledWith(
      expect.stringContaining("Proposed diff (not applied)"),
    );
  });

  it("copies the last assistant message", async () => {
    const copyText = vi.fn(async () => {});
    const ports = createPorts({ getLastAssistantMessage: () => "raw markdown", copyText });

    expect(createInteractiveCommandHandler(ports)("/copy-last")).toBe(true);
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("raw markdown"));
    expect(ports.logSystem).toHaveBeenCalledWith("Copied last assistant message to clipboard.");
  });
});
