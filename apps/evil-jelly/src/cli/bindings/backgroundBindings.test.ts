import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundHostBindings } from "./backgroundBindings";

describe("cli stub host bindings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams transient assistant and tool output by default", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const bindings = createBackgroundHostBindings();

    bindings.printOut("assistant chunk");
    bindings.appendToolOutput?.("tool-1", "tool chunk");

    expect(write).toHaveBeenNthCalledWith(1, "assistant chunk");
    expect(write).toHaveBeenNthCalledWith(2, "tool chunk");
  });

  it("emits only committed prefixed events in committed-only mode", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bindings = createBackgroundHostBindings({ liveOutput: "committed-only" });

    bindings.printOut("assistant chunk");
    bindings.appendToolOutput?.("tool-1", "tool chunk");
    bindings.logToolBlock({
      toolName: "list_directory",
      summary: "[Tools] list_directory → . (depth 2)",
      preview: "files",
      fullResult: "files",
      ok: true,
      outcome: "succeeded",
    });
    bindings.logAssistantMessage("Done");

    expect(write).not.toHaveBeenCalled();
    expect(log).toHaveBeenNthCalledWith(1, "[cli][tool] [Tools] list_directory → . (depth 2)");
    expect(log).toHaveBeenNthCalledWith(2, "[cli][assistant] Done");
  });

  it("accepts readonly shell commands in background headless bindings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bindings = createBackgroundHostBindings();

    await expect(
      bindings.confirmTool({
        type: "shell_command",
        command: "git status",
      }),
    ).resolves.toEqual({ action: "accept" });
  });

  it("categorizes approval decisions in committed logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bindings = createBackgroundHostBindings({ autoAcceptWrite: true });

    await bindings.confirmTool({
      type: "shell_command",
      command: "pnpm test",
    });

    expect(log).toHaveBeenCalledWith("[cli][approval] auto-accept: shell pnpm test");
  });

  it("rejects writes and higher-risk shell commands in background headless bindings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bindings = createBackgroundHostBindings();

    await expect(
      bindings.confirmTool({
        type: "fs_write",
        kind: "edit",
        filePath: "src/index.ts",
        unifiedDiff: "",
        proposedContent: "",
      }),
    ).resolves.toEqual({ action: "reject" });
    await expect(
      bindings.confirmTool({
        type: "shell_command",
        command: "pnpm install",
      }),
    ).resolves.toEqual({ action: "reject" });
  });
});
