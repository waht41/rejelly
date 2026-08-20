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

  it("uses MCP before workspace fallback for explicit and semantic requests", () => {
    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock: "" });

    expect(prompt).toContain(
      "When the user explicitly asks to use or search MCP, call mcp_reference before inspecting the workspace.",
    );
    expect(prompt).toContain(
      "For semantic TypeScript tasks such as references, definitions, hover, and implementations, call mcp_reference first.",
    );
    expect(prompt).toContain("matching callable MCP tool");
    expect(prompt).toContain(
      "If mcp_reference returns request_access or a relevant match with callable=false, call mcp_request once",
    );
    expect(prompt).toContain("do not ask the user to run /mcp manually");
    expect(prompt).toContain("Do not retry synonyms");
    expect(prompt).toContain("otherwise fall back to grep + read_file");
    expect(prompt).not.toContain("There is no language-server/`ts_` tool available");
  });

  it("does not add an empty trailing workspace block", () => {
    const prompt = buildUnifiedSystemPrompt({ workspaceRuleBlock: "  \n" });

    expect(prompt).toMatch(
      /^You are Evil Jelly, also called Evil, a senior coding agent running inside the Evil Jelly application\./,
    );
    expect(prompt).toMatch(/before deciding\.$/);
  });
});
