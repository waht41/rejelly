import { describe, expect, it } from "vitest";
import { renderMcpServerCatalog } from "./catalogPrompt";

describe("MCP server catalog prompt", () => {
  it("publishes a deterministic names-only catalog with progressive-disclosure guidance", () => {
    const prompt = renderMcpServerCatalog(["typescript", "docs", "typescript"]);

    expect(prompt).toContain("<available_mcp_servers>");
    expect(prompt.indexOf("- docs")).toBeLessThan(prompt.indexOf("- typescript"));
    expect(prompt).toContain("Use `mcp_reference` to load matching native tool descriptions");
    expect(prompt).toContain("`callable` field is true");
    expect(prompt).not.toContain("transport");
  });

  it("omits an empty catalog", () => {
    expect(renderMcpServerCatalog([])).toBe("");
  });
});
