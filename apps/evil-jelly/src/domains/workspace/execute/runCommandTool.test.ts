import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";

const hostBindingMock = vi.hoisted(() => ({
  current: null as EvilJellyBindings | null,
}));
const executeShellCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../../../shared/host/context", () => ({
  getBinding: () => {
    if (!hostBindingMock.current) {
      throw new Error("No test host binding registered.");
    }
    return hostBindingMock.current;
  },
}));

vi.mock("./executeShellCommand", () => ({
  executeShellCommand: executeShellCommandMock,
  getShellEnvironmentSummary: () => "test shell",
}));

import { RunCommandTool } from "./runCommandTool";

describe("RunCommandTool cwd policy", () => {
  let previousRoot: string;
  let workspace: string;
  let outsideDir: string;

  beforeEach(async () => {
    previousRoot = getWorkspaceRoot();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-run-workspace-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-run-outside-"));
    setWorkspaceRoot(workspace);
    executeShellCommandMock.mockReset();
    executeShellCommandMock.mockResolvedValue({ exitCode: 0, output: "ok" });
  });

  afterEach(async () => {
    hostBindingMock.current = null;
    setWorkspaceRoot(previousRoot);
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("reports hard timeouts distinctly from ordinary command failures", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    executeShellCommandMock.mockResolvedValue({
      exitCode: null,
      output: "partial output",
      error: { code: "ETIMEDOUT", message: "Command timed out", killed: true },
    });

    const result = await RunCommandTool.handler({
      command: "example",
      declaredSafety: "read_only",
      reason: "test timeout",
    });

    expect(result).toContain("exitCode=null status=timed_out test shell");
    expect(result).toContain("partial output");
    expect(result).toContain("process tree was terminated");
  });

  it("passes an explicit hard timeout to the shell executor", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });

    await RunCommandTool.handler({
      command: "example",
      timeoutMs: 900_000,
      declaredSafety: "read_only",
      reason: "test explicit timeout",
    });

    expect(executeShellCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 900_000 }),
      undefined,
    );
  });

  it("leaves outside cwd authorization to the shell confirmation", async () => {
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });

    const result = await RunCommandTool.handler({
      command: "example",
      cwd: outsideDir,
      declaredSafety: "read_only",
      reason: "test outside cwd",
    });

    expect(outsideAccessRequests).toHaveLength(0);
    expect(executeShellCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "example", cwd: outsideDir }),
      undefined,
    );
    expect(result).toContain("status=ok");
  });
});
