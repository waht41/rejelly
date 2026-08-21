import { describe, expect, it } from "vitest";
import { mcpBoundRouteFixture } from "../__tests__/mcpTestFixtures";
import type { McpReferenceMatch, McpReferenceResult } from "../contracts";
import { projectMcpReferenceForModel } from "./referenceProjection";

function match(
  nativeToolName: string,
  overrides: Partial<McpReferenceMatch> = {},
): McpReferenceMatch {
  return {
    ...mcpBoundRouteFixture({
      identity: { serverId: "typescript", nativeToolName },
      description: `Description for ${nativeToolName}`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      catalogRevision: "catalog-v1",
      configFingerprint: "config-v1",
    }),
    callable: true,
    ...overrides,
  };
}

function result(
  matches: readonly McpReferenceMatch[],
  matchedCount = matches.length,
): McpReferenceResult {
  return { type: "mcp_reference_v1", matchedCount, matches };
}

describe("MCP reference model projection", () => {
  it("fully exposes one exact tool while grouping facts at the server boundary", () => {
    const output = projectMcpReferenceForModel(result([match("get_definition")]));

    expect(output).toContain('detail="full"');
    expect(output).toContain(
      '<server id="typescript" status="ready" callable="true" catalog_revision="catalog-v1">',
    );
    expect(output).toContain('<tool name="get_definition">');
    expect(output).toContain(
      '<input_schema format="json">\n{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}',
    );
    expect(output).not.toContain("config-v1");
  });

  it("omits all schemas together when a broad full projection exceeds its budget", () => {
    const largeSchema = {
      type: "object",
      description: "schema ".repeat(1_000),
    } as const;
    const output = projectMcpReferenceForModel(
      result([
        match("get_definition", { inputSchema: largeSchema }),
        match("get_references", { inputSchema: largeSchema }),
      ]),
      { outputBytes: 2_000 },
    );

    expect(output).toContain('detail="summary"');
    expect(output).toContain('schemas_omitted="2"');
    expect(output).toContain("- `get_definition` — Description for get_definition");
    expect(output.match(/<server id="typescript"/g)).toHaveLength(1);
    expect(output).not.toContain("input_schema");
    expect(output).toContain("Query one exact tool name");
  });

  it("reports both maxResults omission and a single schema hard-limit fallback", () => {
    const output = projectMcpReferenceForModel(
      result(
        [
          match("huge", {
            inputSchema: { type: "object", description: "x".repeat(2_000) },
          }),
        ],
        4,
      ),
      { singleToolOutputBytes: 500 },
    );

    expect(output).toContain('detail="summary"');
    expect(output).toContain('schemas_omitted="1"');
    expect(output).toContain('matches_omitted="3"');
    expect(output).toContain("single-tool output limit");
    expect(output).toContain("3 additional matching tool(s)");
  });

  it("falls back to names-only with an explicit description omission marker", () => {
    const verbose = "description ".repeat(500);
    const output = projectMcpReferenceForModel(
      result([
        match("get_definition", { description: verbose }),
        match("get_references", { description: verbose }),
      ]),
      { outputBytes: 1_200 },
    );

    expect(output).toContain('detail="names"');
    expect(output).toContain('descriptions_omitted="2"');
    expect(output).toContain("Descriptions for 2 returned tool(s) were also omitted.");
  });
});
