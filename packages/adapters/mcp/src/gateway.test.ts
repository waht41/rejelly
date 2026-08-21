import { describe, expect, it, vi } from "vitest";
import { McpProtocolError } from "./errors";
import {
  callMcpTool,
  loadMcpToolCatalog,
  normalizeMcpCallResult,
  normalizeMcpToolCatalog,
  validateMcpToolArguments,
} from "./gateway";

describe("MCP gateway protocol helpers", () => {
  it("loads, normalizes, and refreshes catalogs without an equip cache", async () => {
    const listTools = vi
      .fn<(params?: { cursor?: string }) => Promise<unknown>>()
      .mockResolvedValueOnce({
        tools: [{ name: "write", inputSchema: { type: "object" } }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
      })
      .mockResolvedValueOnce({
        tools: [{ name: "search", inputSchema: { type: "object" } }],
      });

    const first = await loadMcpToolCatalog({ listTools });
    const second = await loadMcpToolCatalog({ listTools });

    expect(first.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(second.map((tool) => tool.name)).toEqual(["search"]);
    expect(listTools.mock.calls).toEqual([[undefined], [{ cursor: "page-2" }], [undefined]]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0]?.inputSchema)).toBe(true);
  });

  it("rejects ambiguous or malformed catalogs", () => {
    let duplicate: unknown;
    try {
      normalizeMcpToolCatalog([
        { name: "read", inputSchema: { type: "object" } },
        { name: "read", inputSchema: { type: "object" } },
      ]);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(McpProtocolError);
    expect(duplicate).toMatchObject({
      name: "McpProtocolError",
      code: "duplicate_tool_name",
      toolName: "read",
    });

    let malformed: unknown;
    try {
      normalizeMcpToolCatalog([{ name: "read", inputSchema: [] }]);
    } catch (error) {
      malformed = error;
    }
    expect(malformed).toMatchObject({
      name: "McpProtocolError",
      code: "invalid_tool_schema",
      toolName: "read",
    });
  });

  it("preserves the underlying cause without copying the raw descriptor", () => {
    let failure: unknown;
    try {
      normalizeMcpToolCatalog([
        { name: "read", inputSchema: { type: "object", unsupported: () => undefined } },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "McpProtocolError",
      code: "invalid_tool_schema",
      toolName: "read",
    });
    expect((failure as McpProtocolError).cause).toBeDefined();
    expect(failure).not.toHaveProperty("descriptor");
  });

  it("validates arguments with native JSON Schema semantics", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { enum: ["summary", "full"] },
        target: {
          anyOf: [
            { type: "string", minLength: 3 },
            { type: "integer", minimum: 1 },
          ],
        },
      },
      required: ["mode", "target"],
      additionalProperties: false,
    } as const;

    expect(validateMcpToolArguments(schema, { mode: "summary", target: 2 })).toEqual({
      ok: true,
    });
    const invalid = validateMcpToolArguments(schema, {
      mode: "other",
      target: "x",
      extra: true,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.reason).toBe("invalid_arguments");
      expect(invalid.issues.map((issue) => issue.keyword)).toEqual(
        expect.arrayContaining(["additionalProperties", "enum", "anyOf"]),
      );
    }
  });

  it("accepts arbitrary nested JSON arguments without flattening their structure", () => {
    const schema = {
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: {
            batches: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  filters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { field: { type: "string" }, values: { type: "array" } },
                      required: ["field", "values"],
                    },
                  },
                },
                required: ["filters"],
              },
            },
          },
          required: ["batches"],
        },
      },
      required: ["request"],
    } as const;
    const argumentsValue = {
      request: {
        batches: [
          {
            filters: [{ field: "labels", values: ["bug", 3, true, null, { nested: [1, 2] }] }],
          },
        ],
      },
    };

    expect(validateMcpToolArguments(schema, argumentsValue)).toEqual({ ok: true });
  });

  it("reports invalid server schemas separately from invalid arguments", () => {
    const result = validateMcpToolArguments({ type: "not-a-json-schema-type" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_schema");
  });

  it("normalizes call results without erasing MCP errors or structured content", async () => {
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: "denied" }],
        structuredContent: { code: "forbidden" },
        isError: true,
      })),
    };

    const result = await callMcpTool(client, "write", { value: 1 });

    expect(client.callTool).toHaveBeenCalledWith({
      name: "write",
      arguments: { value: 1 },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "denied" }],
      structuredContent: { code: "forbidden" },
      isError: true,
    });
    expect(Object.isFrozen(result.content[0])).toBe(true);
  });

  it("rejects malformed native content before it reaches a provider", () => {
    let failure: unknown;
    try {
      normalizeMcpCallResult({ content: [{ type: "image", data: "abc" }] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "McpProtocolError",
      code: "invalid_call_result",
    });
  });
});
