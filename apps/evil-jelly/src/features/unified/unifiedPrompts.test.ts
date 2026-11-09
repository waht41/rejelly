import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommandShell } from "../../domains/workspace/execute/commandShell";
import { buildUnifiedInstruction, buildUnifiedSystemPrompt } from "./unifiedPrompts";

vi.mock("../../domains/workspace/execute/commandShell", () => ({
  getCommandShell: vi.fn(),
}));

const buildDefaultSystemPrompt = () => buildUnifiedSystemPrompt({ workspaceRuleBlock: "" });
const scratchDir = path.join(os.tmpdir(), "evil-jelly-prompt-scratch");

describe("buildUnifiedSystemPrompt", () => {
  it("builds the application framework in a stable order", () => {
    const prompt = buildDefaultSystemPrompt();
    const sectionPositions = [
      "TASK EXECUTION:",
      "SAFETY AND EXISTING WORK:",
      "WORKSPACE EXPLORATION:",
      "EDITING AND VERIFICATION:",
      "COMPLETION AND REPORTING:",
    ].map((title) => prompt.indexOf(title));

    expect(prompt).toMatch(/^You are Evil Jelly, also called Evil,/);
    expect(sectionPositions.every((position) => position >= 0)).toBe(true);
    expect(sectionPositions).toEqual([...sectionPositions].sort((a, b) => a - b));
    expect(prompt).toBe(prompt.trim());
  });

  it("appends non-empty workspace instructions after the application framework", () => {
    const workspaceRuleBlock = [
      '<workspace-instructions source="AGENTS.md">',
      "Run the focused tests.",
      "</workspace-instructions>",
    ].join("\n");

    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock });

    expect(prompt.endsWith(workspaceRuleBlock)).toBe(true);
    expect(prompt.indexOf("COMPLETION AND REPORTING:")).toBeLessThan(
      prompt.indexOf(workspaceRuleBlock),
    );
  });

  it("uses structured and complementary workspace exploration without embedding MCP routing", () => {
    const prompt = buildDefaultSystemPrompt();

    for (const tool of ["list_directory", "fuzzy_search_paths", "grep"]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toMatch(/multiple complementary methods/i);
    expect(prompt).toMatch(/a small number of plausible locations or code paths/i);
    expect(prompt).toMatch(/without materially new evidence/i);
    expect(prompt).not.toMatch(/\bMCP\b|mcp_/);
  });
});

describe("buildUnifiedInstruction", () => {
  beforeEach(() => {
    vi.mocked(getCommandShell).mockReturnValue({ path: "/bin/sh", kind: "posix" });
  });

  it.each([
    {
      shell: { path: "C:\\PowerShell\\7\\pwsh.exe", kind: "pwsh" as const },
      note: "PowerShell 7+ syntax; && and || are supported",
    },
    {
      shell: { path: "C:\\Windows\\powershell.exe", kind: "windows-powershell" as const },
      note: "Windows PowerShell syntax; use semicolons instead of && or ||",
    },
    { shell: { path: "/bin/zsh", kind: "posix" as const }, note: undefined },
  ])("reports the selected $shell.kind interpreter and matching syntax", ({ shell, note }) => {
    vi.mocked(getCommandShell).mockReturnValue(shell);
    const instruction = buildUnifiedInstruction({ scratchDir, artifactSummary: "" });
    const shellLine = instruction.split("\n").find((line) => line.startsWith("Shell: "));
    expect(shellLine).toBe(
      `Shell: ${shell.path}${note ? ` (${note}; do not assume POSIX utilities are installed)` : ""}`,
    );
  });
  it("puts the resolved scratch path only in dynamic Environment context", () => {
    const instruction = buildUnifiedInstruction({ scratchDir, artifactSummary: "" });
    const system = buildDefaultSystemPrompt();

    expect(instruction).toContain(`Agent Scratch Dir: ${scratchDir}`);
    expect(system).toContain("Agent Scratch Dir provided in Environment");
    expect(system).not.toContain(scratchDir);
    expect(system).not.toContain(".evil-jelly/tmp");
  });

  it("adds terminal reply guidance only to terminal instructions", () => {
    const terminalInstruction = buildUnifiedInstruction({
      scratchDir,
      artifactSummary: "",
      useTerminalUserReplyRule: true,
    });
    const documentInstruction = buildUnifiedInstruction({
      scratchDir,
      artifactSummary: "",
      useTerminalUserReplyRule: false,
    });

    expect(buildDefaultSystemPrompt()).not.toContain("Terminal user reply format:");
    expect(terminalInstruction).toContain("Terminal user reply format:");
    expect(documentInstruction).not.toContain("Terminal user reply format:");
  });

  it("mentions artifact recovery only when artifacts are present", () => {
    const withoutArtifacts = buildUnifiedInstruction({ scratchDir, artifactSummary: "" });
    const withArtifacts = buildUnifiedInstruction({
      scratchDir,
      artifactSummary: "- artifact_1234: truncated output",
    });

    expect(withoutArtifacts).not.toContain("readArtifact");
    expect(withArtifacts).toContain("readArtifact");
  });
});
