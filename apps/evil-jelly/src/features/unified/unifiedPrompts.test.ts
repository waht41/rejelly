import { describe, expect, it } from "vitest";
import { buildUnifiedInstruction, buildUnifiedSystemPrompt } from "./unifiedPrompts";

const buildDefaultSystemPrompt = () => buildUnifiedSystemPrompt({ workspaceRuleBlock: "" });

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

  it("uses breadth-first structured workspace exploration without embedding MCP routing", () => {
    const prompt = buildDefaultSystemPrompt();

    for (const tool of ["list_directory", "fuzzy_search_paths", "grep", "AST tools"]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toMatch(/breadth before depth/i);
    expect(prompt).toMatch(/multiple plausible hypotheses or code paths/i);
    expect(prompt).not.toMatch(/\bMCP\b|mcp_/);
  });
});

describe("buildUnifiedInstruction", () => {
  it("adds terminal reply guidance only to terminal instructions", () => {
    const terminalInstruction = buildUnifiedInstruction({
      artifactSummary: "",
      useTerminalUserReplyRule: true,
    });
    const documentInstruction = buildUnifiedInstruction({
      artifactSummary: "",
      useTerminalUserReplyRule: false,
    });

    expect(buildDefaultSystemPrompt()).not.toContain("Terminal user reply format:");
    expect(terminalInstruction).toContain("Terminal user reply format:");
    expect(documentInstruction).not.toContain("Terminal user reply format:");
  });

  it("mentions artifact recovery only when artifacts are present", () => {
    const withoutArtifacts = buildUnifiedInstruction({ artifactSummary: "" });
    const withArtifacts = buildUnifiedInstruction({
      artifactSummary: "- artifact_1234: truncated output",
    });

    expect(withoutArtifacts).not.toContain("readArtifact");
    expect(withArtifacts).toContain("readArtifact");
  });
});
