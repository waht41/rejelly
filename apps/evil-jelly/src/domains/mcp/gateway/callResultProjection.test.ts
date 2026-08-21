import type { McpNormalizedCallResult } from "@rejelly/adapter-mcp";
import { describe, expect, it } from "vitest";
import type { McpCallPolicyResult } from "../contracts";
import { projectMcpCallResultForModel } from "./callResultProjection";

function completed(result: McpNormalizedCallResult): McpCallPolicyResult<McpNormalizedCallResult> {
  return {
    type: "mcp_call_result_v1",
    status: "completed",
    tool: { serverId: "typescript", nativeToolName: "get_symbols" },
    catalogRevision: "catalog-v1",
    result,
  };
}

describe("MCP call result model projection", () => {
  it("projects native text and structured JSON under one metadata envelope", () => {
    const output = projectMcpCallResultForModel(
      completed({
        content: [{ type: "text", text: "symbols:\n- JellyLintConfig" }],
        isError: false,
        structuredContent: { symbols: [{ name: "JellyLintConfig" }] },
      }),
    );

    expect(output).toContain(
      '<mcp_call_result version="1" status="completed" server="typescript" tool="get_symbols" catalog_revision="catalog-v1" is_error="false">',
    );
    expect(output).toContain('<text index="0" format="text">\nsymbols:');
    expect(output).toContain(
      '<structured_content format="json">\n{"symbols":[{"name":"JellyLintConfig"}]}',
    );
  });

  it("deduplicates structured content that is already present as JSON text", () => {
    const output = projectMcpCallResultForModel(
      completed({
        content: [{ type: "text", text: '{"symbols":["A"]}' }],
        isError: false,
        structuredContent: { symbols: ["A"] },
      }),
    );

    expect(output).toContain(
      '<structured_content omitted="true" reason="duplicate_text_content" />',
    );
    expect(output.match(/"symbols"/g)).toHaveLength(1);
  });

  it("keeps output bounded and never emits a partial JSON structured-content block", () => {
    const output = projectMcpCallResultForModel(
      completed({
        content: [{ type: "text", text: "x".repeat(20_000) }],
        isError: false,
        structuredContent: { rows: ["y".repeat(20_000)] },
      }),
      { outputBytes: 4_096 },
    );

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4_096);
    expect(output).toContain('truncated="true"');
    expect(output).toContain('reason="output_budget"');
    expect(output).toContain(
      '<structured_content omitted="true" reason="output_budget" original_bytes="20013" />',
    );
    expect(output).not.toContain('<structured_content format="json">');
  });

  it("projects binary and resource blocks without embedding base64 data", () => {
    const output = projectMcpCallResultForModel(
      completed({
        content: [
          { type: "image", data: "abcdef", mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "file:///guide.md",
              text: "guide",
              blob: "encoded",
              mimeType: "text/markdown",
            },
          },
        ],
        isError: false,
      }),
    );

    expect(output).toContain(
      '<image index="0" mime_type="image/png" data_omitted="true" encoded_chars="6" />',
    );
    expect(output).toContain('uri="file:///guide.md"');
    expect(output).toContain('<blob data_omitted="true" encoded_chars="7" />');
    expect(output).not.toContain("abcdef");
    expect(output).not.toContain("encoded\n");
  });

  it("projects policy rejections without a JSON wrapper", () => {
    const output = projectMcpCallResultForModel({
      type: "mcp_call_result_v1",
      status: "rejected",
      tool: { serverId: "typescript", nativeToolName: "get_symbols" },
      code: "catalog_changed",
      message: "Catalog changed.",
      currentCatalogRevision: "catalog-v2",
    });

    expect(output).toContain(
      '<mcp_call_result version="1" status="rejected" server="typescript" tool="get_symbols" code="catalog_changed" current_catalog_revision="catalog-v2">',
    );
    expect(output).toContain("<message>\nCatalog changed.\n</message>");
  });
});
