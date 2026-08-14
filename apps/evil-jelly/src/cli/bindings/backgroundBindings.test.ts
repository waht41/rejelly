import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundHostBindings } from "./backgroundBindings";

describe("cli stub host bindings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
