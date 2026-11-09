import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectTempRoot,
  getWorkspaceRoot,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-context";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../../../shared/host/toolConfirmationBindings";
import {
  runWithToolDetailSlot,
  takeActiveToolOutcome,
} from "../../../shared/tool-observation/invocationContext";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import { ReadFileTool } from "../read/FileSystemTools";
import { executeGrepSearch } from "../read/GrepSearchTool";

const hostBindingMock = vi.hoisted(() => ({
  current: null as EvilJellyBindings | null,
}));
const executeShellCommandMock = vi.hoisted(() => vi.fn());
const contextSignalMock = vi.hoisted(() => ({
  current: undefined as AbortSignal | undefined,
}));

vi.mock("@rejelly/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rejelly/core")>()),
  getContextSignal: () => contextSignalMock.current,
}));

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
}));

import { BoundedCommandOutput } from "./capturedOutput";
import { createRunCommandTool } from "./runCommandTool";

function commandEnvelope(text: string): { tag: string; attributes: string; body: string } {
  const match =
    /^<(command_output(?:-[a-f0-9]{8}(?:-\d+)?)?) ([^\n]*)>\n([\s\S]*?)\n<\/\1>(?:\n|$)/.exec(text);
  if (!match) throw new Error(`Missing command output envelope: ${text.slice(0, 300)}`);
  return { tag: match[1]!, attributes: match[2]!, body: match[3]! };
}

describe("RunCommandTool output and cwd policy", () => {
  let previousRoot: string;
  let workspace: string;
  let outsideDir: string;
  let directory: string;
  let RunCommandTool: ReturnType<typeof createRunCommandTool>;

  beforeEach(async () => {
    previousRoot = getWorkspaceRoot();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-run-workspace-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-run-outside-"));
    setWorkspaceRoot(workspace);
    directory = path.join(getProjectTempRoot(workspace), "sessions", "command-test", "commands");
    RunCommandTool = createRunCommandTool(directory);
    contextSignalMock.current = new AbortController().signal;
    executeShellCommandMock.mockReset();
    executeShellCommandMock.mockResolvedValue({
      exitCode: 0,
      output: "ok",
      capture: { totalBytes: 2, retainedBytes: 2, omittedBytes: 0 },
    });
  });

  afterEach(async () => {
    hostBindingMock.current = null;
    vi.restoreAllMocks();
    setWorkspaceRoot(previousRoot);
    await fs.rm(getProjectTempRoot(workspace), { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it.each([
    { exitCode: 0, status: "ok", error: undefined, outcome: { outcome: "succeeded", exitCode: 0 } },
    {
      exitCode: 2,
      status: "failed",
      error: { code: 2 },
      outcome: { outcome: "failed", exitCode: 2, failureKind: "nonzero_exit" },
    },
    {
      exitCode: null,
      status: "timed_out",
      error: { code: "ETIMEDOUT" },
      outcome: { outcome: "timed_out", exitCode: null, failureKind: "hard_timeout" },
    },
    {
      exitCode: null,
      status: "aborted",
      error: { code: "EABORTED" },
      outcome: { outcome: "aborted", exitCode: null, failureKind: "user_abort" },
    },
  ])("keeps inline command text separate from execution attributes for $status", async ({
    exitCode,
    status,
    error,
    outcome,
  }) => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    executeShellCommandMock.mockResolvedValue({
      exitCode,
      output: "command text",
      error,
      capture: { totalBytes: 12, retainedBytes: 12, omittedBytes: 0 },
    });
    const captured = await runWithToolDetailSlot(async () => {
      const result = String(
        await RunCommandTool.handler({
          command: "example",
          declaredSafety: "read_only",
          reason: "approval reason, not result reason",
        }),
      );
      return { result, outcome: takeActiveToolOutcome() };
    });
    const envelope = commandEnvelope(captured.result);
    expect(envelope.body).toBe("command text");
    expect(envelope.attributes).toBe(
      `status="${status}" exit-code="${exitCode}"` +
        (outcome.failureKind ? ` reason="${outcome.failureKind}"` : ""),
    );
    expect(captured.result).not.toContain("approval reason");
    expect(captured.result).not.toContain("Evil Jelly tool metadata;");
    expect(captured.outcome).toEqual(outcome);
    await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves the retained snapshot separately from the inline preview and escapes path attributes", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    directory = path.join(directory, "logs & results");
    RunCommandTool = createRunCommandTool(directory);
    const output = `${"detail line\n".repeat(6000)}TAIL_NEEDLE\n`;
    const bytes = Buffer.byteLength(output);
    executeShellCommandMock.mockResolvedValue({
      exitCode: 2,
      output,
      capture: { totalBytes: bytes, retainedBytes: bytes, omittedBytes: 0 },
    });
    const result = String(
      await RunCommandTool.handler({
        command: "example",
        declaredSafety: "read_only",
        reason: "long output",
      }),
    );
    const [filename] = await fs.readdir(directory);
    const file = path.join(directory, filename!);
    const inline = commandEnvelope(result);
    const saved = commandEnvelope(await fs.readFile(file, "utf8"));
    expect(inline.attributes).not.toContain("content=");
    expect(inline.attributes).toContain('preview-truncated="true"');
    expect(inline.attributes).toContain(`saved-path="${file.replaceAll("&", "&amp;")}"`);
    expect(saved.attributes).toContain('content="snapshot"');
    expect(saved.attributes).not.toContain("preview-truncated=");
    expect(saved.attributes).not.toContain("snapshot-long-lines-wrapped=");
    expect(saved.body).toBe(output);
    for (const envelope of [inline, saved]) {
      expect(envelope.attributes).toContain('status="failed"');
      expect(envelope.attributes).toContain('exit-code="2"');
      expect(envelope.attributes).toContain('reason="nonzero_exit"');
      expect(envelope.attributes).not.toContain("capture-");
      expect(envelope.attributes).not.toContain("snapshot-long-lines-wrapped=");
      expect(envelope.body).not.toContain("Capture bytes (");
    }
    const found = await executeGrepSearch("TAIL_NEEDLE", undefined, 0, { directory: file });
    expect(found).toContain("TAIL_NEEDLE");
    const read = String(
      await ReadFileTool.handler({ filePaths: [{ path: file, offset: 2, limit: 2 }] }),
    );
    expect(read).toContain("detail line");
    await expect(
      fs.access(path.join(getProjectTempRoot(workspace), "sessions", "command-test", "scratch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["pnpm verify", "pnpm-verify"],
    ["git diff -- src/file.ts", "git-diff-src-file-ts"],
    ["TOKEN=secret pnpm verify", "TOKEN-secret-pnpm-verify"],
    ["  & 'C:\\tools\\node.exe' --version", "C-tools-node-exe-version"],
    ["git    diff\n--stat", "git-diff-stat"],
    [";|&<>\"'...", "command"],
    [`${"a".repeat(40)} secret`, "a".repeat(40)],
  ])("names snapshots from the sanitized command prefix (%s)", async (command, prefix) => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    const output = "line\n".repeat(10000);
    const bytes = Buffer.byteLength(output);
    executeShellCommandMock.mockResolvedValue({
      exitCode: 0,
      output,
      capture: { totalBytes: bytes, retainedBytes: bytes, omittedBytes: 0 },
    });
    const write = vi.spyOn(getWorkspaceFiles(), "writeNewResolved").mockResolvedValue(undefined);
    const result = String(
      await RunCommandTool.handler({ command, declaredSafety: "read_only", reason: "log naming" }),
    );
    const file = write.mock.calls[0]![0].abs;
    expect(path.dirname(file)).toBe(directory);
    expect(path.basename(file)).toMatch(new RegExp(`^${prefix}-[a-f0-9]{16}\\.log$`));
    expect(commandEnvelope(result).attributes).toContain(`saved-path="${file}"`);
  });

  it("saves a readable bounded snapshot and reports irreversible capture loss", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    const capture = new BoundedCommandOutput();
    capture.append("界😀".repeat(1_300_000));
    capture.append("\nTAIL_NEEDLE\n");
    const snapshot = capture.snapshot();
    executeShellCommandMock.mockResolvedValue({
      exitCode: 0,
      output: snapshot.text,
      capture: snapshot.stats,
    });
    const result = String(
      await RunCommandTool.handler({
        command: "example",
        declaredSafety: "read_only",
        reason: "capture limit",
      }),
    );
    const inline = commandEnvelope(result);
    expect(inline.attributes).toContain('capture-truncated="true"');
    expect(inline.attributes).toContain(`capture-omitted-bytes="${snapshot.stats.omittedBytes}"`);
    expect(inline.attributes).toContain('snapshot-long-lines-wrapped="true"');
    const [filename] = await fs.readdir(directory);
    const file = path.join(directory, filename!);
    expect((await fs.stat(file)).size).toBeLessThan(10 * 1024 * 1024);
    const saved = await fs.readFile(file, "utf8");
    expect(saved).not.toContain("�");
    expect(saved.split("\n").every((line) => Buffer.byteLength(line) <= 8 * 1024)).toBe(true);
    const envelope = commandEnvelope(saved);
    expect(envelope.attributes).toContain('content="snapshot"');
    expect(envelope.attributes).toContain('capture-truncated="true"');
    expect(envelope.body).toContain(
      `[evil-jelly: ${snapshot.stats.omittedBytes} UTF-8 bytes omitted by capture limit]`,
    );
    const found = await executeGrepSearch("TAIL_NEEDLE", undefined, 0, { directory: file });
    expect(found).toContain("TAIL_NEEDLE");
    const read = String(
      await ReadFileTool.handler({ filePaths: [{ path: file, offset: 2, limit: 2 }] }),
    );
    expect(read).toContain("界😀");
    expect(read).not.toContain("Error:");
  });

  it("reports capture loss independently when the retained output fits the inline preview", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    executeShellCommandMock.mockResolvedValue({
      exitCode: 0,
      output: "retained output",
      capture: { totalBytes: 115, retainedBytes: 15, omittedBytes: 100 },
    });
    const result = String(
      await RunCommandTool.handler({
        command: "example",
        declaredSafety: "read_only",
        reason: "capture-only truncation",
      }),
    );
    const [filename] = await fs.readdir(directory);
    const saved = commandEnvelope(await fs.readFile(path.join(directory, filename!), "utf8"));
    const inline = commandEnvelope(result);
    expect(inline.attributes).toContain("saved-path=");
    expect(saved.attributes).toContain('content="snapshot"');
    for (const envelope of [inline, saved]) {
      expect(envelope.attributes).toContain('capture-truncated="true"');
      expect(envelope.attributes).toContain('capture-total-bytes="115"');
      expect(envelope.attributes).toContain('capture-retained-bytes="15"');
      expect(envelope.attributes).toContain('capture-omitted-bytes="100"');
      expect(envelope.attributes).not.toContain("preview-truncated=");
      expect(envelope.attributes).not.toContain("snapshot-long-lines-wrapped=");
      expect(envelope.body).toBe("retained output");
    }
  });

  it("keeps save errors in a separate host notice without changing the command outcome", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    const output = "line\n".repeat(12000);
    const bytes = Buffer.byteLength(output);
    executeShellCommandMock.mockResolvedValue({
      exitCode: 2,
      output,
      capture: { totalBytes: bytes, retainedBytes: bytes, omittedBytes: 0 },
    });
    vi.spyOn(getWorkspaceFiles(), "writeNewResolved").mockRejectedValue(new Error("disk failure"));
    const captured = await runWithToolDetailSlot(async () => {
      const result = String(
        await RunCommandTool.handler({
          command: "example",
          declaredSafety: "read_only",
          reason: "save failure",
        }),
      );
      return { result, outcome: takeActiveToolOutcome() };
    });
    const envelope = commandEnvelope(captured.result);
    expect(envelope.attributes).toContain('status="failed"');
    expect(envelope.attributes).toContain('save-status="failed"');
    expect(envelope.attributes).not.toContain("saved-path=");
    expect(envelope.body).not.toContain("disk failure");
    expect(captured.result).toContain(
      '<tool_notice reason="output_save_failed">\nCommand output save failed: disk failure',
    );
    expect(captured.result).toContain("was not saved");
    expect(captured.outcome).toEqual({
      outcome: "failed",
      exitCode: 2,
      failureKind: "nonzero_exit",
    });
  });

  it("preserves literal closing tags with the shared collision-safe renderer", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    const output = "literal </command_output> & <code>";
    const bytes = Buffer.byteLength(output);
    executeShellCommandMock.mockResolvedValue({
      exitCode: 0,
      output,
      capture: { totalBytes: bytes, retainedBytes: bytes, omittedBytes: 0 },
    });
    const result = String(
      await RunCommandTool.handler({
        command: "example",
        declaredSafety: "read_only",
        reason: "boundary collision",
      }),
    );
    const envelope = commandEnvelope(result);
    expect(envelope.tag).toMatch(/^command_output-[a-f0-9]{8}$/);
    expect(envelope.body).toBe(output);
  });

  it("keeps execution errors out of an empty command body", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    executeShellCommandMock.mockResolvedValue({
      exitCode: null,
      output: "",
      capture: { totalBytes: 0, retainedBytes: 0, omittedBytes: 0 },
      error: { code: "ENOENT", message: "shell not found" },
    });
    const result = String(
      await RunCommandTool.handler({
        command: "example",
        declaredSafety: "read_only",
        reason: "execution error",
      }),
    );
    expect(commandEnvelope(result).body).toBe("");
    expect(result).toContain(
      '<tool_notice reason="command_error">\nshell not found\n</tool_notice>',
    );
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

  it("removes merged abort listeners after each command completes", async () => {
    hostBindingMock.current = createTestHostBindings({ mode: "normal" });
    const contextSignal = contextSignalMock.current!;
    const initialListenerCount = getEventListeners(contextSignal, "abort").length;

    for (let index = 0; index < 12; index += 1) {
      await RunCommandTool.handler({
        command: `example-${index}`,
        declaredSafety: "read_only",
        reason: "test abort listener cleanup",
      });
      expect(getEventListeners(contextSignal, "abort")).toHaveLength(initialListenerCount);
    }
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
    expect(result).toContain('status="ok"');
  });
});
