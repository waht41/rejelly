import { describe, expect, it } from "vitest";
import { buildUnifiedSystemPrompt } from "./unifiedPrompts";

describe("buildUnifiedSystemPrompt", () => {
  it("identifies as Evil Jelly and can discover its CLI capabilities", () => {
    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock: "" });

    expect(prompt).toMatch(
      /^You are Evil Jelly, also called Evil, a senior coding agent running inside the Evil Jelly application\./,
    );
    expect(prompt).toContain("use run_command to execute `evil --help`");
    expect(prompt).toContain("execute `evil <subcommand> --help`");
    expect(prompt).toContain("Treat the help output as the source of truth instead of guessing.");
  });

  it("places workspace instructions after the stable application framework", () => {
    const workspaceRuleBlock = [
      '<workspace-instructions source="AGENTS.md">',
      "Run the focused tests.",
      "</workspace-instructions>",
    ].join("\n");

    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock });

    expect(prompt).toMatch(
      /^You are Evil Jelly, also called Evil, a senior coding agent running inside the Evil Jelly application\./,
    );
    expect(prompt.indexOf("CRITICAL RULES:")).toBeLessThan(prompt.indexOf(workspaceRuleBlock));
    expect(prompt.endsWith(workspaceRuleBlock)).toBe(true);
  });

  it("does not add an empty trailing workspace block", () => {
    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock: "  \n" });

    expect(prompt).toMatch(
      /^You are Evil Jelly, also called Evil, a senior coding agent running inside the Evil Jelly application\./,
    );
    expect(prompt).toMatch(/before deciding\.$/);
  });
});
