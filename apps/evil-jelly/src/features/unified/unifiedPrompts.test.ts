import { describe, expect, it } from "vitest";
import { buildUnifiedSystemPrompt } from "./unifiedPrompts";

describe("buildUnifiedSystemPrompt", () => {
  it("places workspace instructions after the stable application framework", () => {
    const workspaceRuleBlock = [
      '<workspace-instructions source="AGENTS.md">',
      "Run the focused tests.",
      "</workspace-instructions>",
    ].join("\n");

    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock });

    expect(prompt).toMatch(/^You are a senior coding agent\./);
    expect(prompt.indexOf("CRITICAL RULES:")).toBeLessThan(prompt.indexOf(workspaceRuleBlock));
    expect(prompt.endsWith(workspaceRuleBlock)).toBe(true);
  });

  it("does not add an empty trailing workspace block", () => {
    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock: "  \n" });

    expect(prompt).toMatch(/^You are a senior coding agent\./);
    expect(prompt).toMatch(/before deciding\.$/);
  });
});
