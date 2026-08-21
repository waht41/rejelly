import type { ToolContext } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { previewToolResult, projectToolStart, stringifyToolResult } from "./projection";

function context(toolName: string, input: unknown): ToolContext {
  return { toolName, input } as ToolContext;
}

describe("tool observation projection", () => {
  it("projects a bounded headline and recoverable arguments", () => {
    const projected = projectToolStart(
      context("run_command", { command: "node <<'EOF'\nconsole.log(1)\nEOF" }),
    );

    expect(projected.summary).toBe("[Tools] run_command → node <<'EOF' console.log(1) EOF");
    expect(JSON.parse(projected.args).command).toContain("\nconsole.log(1)\n");
  });

  it("redacts write bodies from observed arguments", () => {
    const projected = projectToolStart(
      context("create_file", {
        targets: [{ filePath: "generated.ts", content: "first\nsecond\nthird" }],
      }),
    );

    expect(projected.args).toContain('"content": "<omitted: 18 chars, 3 lines>"');
    expect(projected.args).not.toContain("first\\nsecond\\nthird");
  });

  it("projects MCP gateway queries and structured tool identities", () => {
    expect(
      projectToolStart(context("mcp_reference", { query: "typescript references" })).summary,
    ).toBe('[Tools] mcp_reference → "typescript references"');
    expect(projectToolStart(context("mcp_request", { serverId: "typescript" })).summary).toBe(
      "[Tools] mcp_request → typescript",
    );
    expect(
      projectToolStart(
        context("mcp_call", {
          tool: { serverId: "typescript", nativeToolName: "get_references" },
        }),
      ).summary,
    ).toBe("[Tools] mcp_call → typescript/get_references");
  });

  it("serializes results and bounds their preview", () => {
    const result = stringifyToolResult({ lines: Array.from({ length: 10 }, (_, i) => i + 1) });
    expect(result).toContain('"lines"');
    expect(
      previewToolResult(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")),
    ).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n…");
  });
});
