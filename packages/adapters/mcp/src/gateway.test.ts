import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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

  it("accepts Draft-07 schemas generated from Zod by MCP SDKs", () => {
    const schema = zodToJsonSchema(z.object({ traceId: z.string().optional() })) as Record<
      string,
      unknown
    >;
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    const originalSchema = structuredClone(schema);
    const argumentsValue = { traceId: "f7a7dc9b9ee4dd5d213e988917fc18e9" };

    expect(validateMcpToolArguments(schema, argumentsValue)).toEqual({ ok: true });
    expect(validateMcpToolArguments(schema, {})).toEqual({ ok: true });
    expect(validateMcpToolArguments(schema, { traceId: 123 })).toMatchObject({
      ok: false,
      reason: "invalid_arguments",
      issues: [expect.objectContaining({ instancePath: "/traceId", keyword: "type" })],
    });
    expect(schema).toEqual(originalSchema);
    expect(argumentsValue).toEqual({ traceId: "f7a7dc9b9ee4dd5d213e988917fc18e9" });
  });

  it.each([
    "http://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft-07/schema",
    "https://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft-07/schema",
  ])("preserves Draft-07 tuple and reference semantics for %s", ($schema) => {
    const schema = {
      $schema,
      type: "object",
      definitions: { traceId: { type: "string", minLength: 1 } },
      properties: {
        target: {
          type: "array",
          items: [{ $ref: "#/definitions/traceId" }, { type: "integer", minimum: 1 }],
          additionalItems: false,
          minItems: 2,
        },
      },
      required: ["target"],
      additionalProperties: false,
    };

    expect(validateMcpToolArguments(schema, { target: ["trace-1", 1] })).toEqual({
      ok: true,
    });
    for (const argumentsValue of [
      { target: [1, "trace-1"] },
      { target: ["", 1] },
      { target: ["trace-1", 0] },
      { target: ["trace-1", 1, "extra"] },
      { target: ["trace-1"] },
      { target: ["trace-1", 1], extra: true },
    ]) {
      expect(validateMcpToolArguments(schema, argumentsValue)).toMatchObject({
        ok: false,
        reason: "invalid_arguments",
      });
    }
  });

  it.each([
    undefined,
    "https://json-schema.org/draft/2020-12/schema",
  ])("preserves Draft 2020-12 semantics with dialect %s", ($schema) => {
    const schema = {
      ...($schema === undefined ? {} : { $schema }),
      type: "object",
      $defs: { traceId: { type: "string", minLength: 1 } },
      properties: {
        target: {
          type: "array",
          prefixItems: [{ $ref: "#/$defs/traceId" }, { type: "integer", minimum: 1 }],
          items: false,
          minItems: 2,
        },
      },
      required: ["target"],
    };

    expect(validateMcpToolArguments(schema, { target: ["trace-1", 1] })).toEqual({
      ok: true,
    });
    for (const target of [[1, "trace-1"], ["trace-1", 1, "extra"], ["trace-1"]]) {
      expect(validateMcpToolArguments(schema, { target })).toMatchObject({
        ok: false,
        reason: "invalid_arguments",
      });
    }
  });

  it.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft-07/schema#",
  ])("rejects malformed Draft-07 schemas with dialect %s", ($schema) => {
    expect(validateMcpToolArguments({ $schema, type: "invalid" }, {})).toMatchObject({
      ok: false,
      reason: "invalid_schema",
    });
  });

  it.each([
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2019-09/schema#",
  ])("preserves Draft 2019-09 tuple and unevaluated-property semantics for %s", ($schema) => {
    const schema = {
      $schema,
      type: "object",
      properties: {
        target: {
          type: "array",
          items: [{ type: "string" }, { type: "integer" }],
          additionalItems: false,
          minItems: 2,
        },
      },
      required: ["target"],
      unevaluatedProperties: false,
    };
    expect(validateMcpToolArguments(schema, { target: ["trace-1", 1] })).toEqual({ ok: true });
    for (const argumentsValue of [
      { target: [1, "trace-1"] },
      { target: ["trace-1", 1, "extra"] },
      { target: ["trace-1", 1], extra: true },
    ]) {
      expect(validateMcpToolArguments(schema, argumentsValue)).toMatchObject({
        ok: false,
        reason: "invalid_arguments",
      });
    }
    expect(validateMcpToolArguments({ $schema, type: "invalid" }, {})).toMatchObject({
      ok: false,
      reason: "invalid_schema",
    });
  });

  it("rejects unsupported dialects instead of silently using different semantics", () => {
    expect(
      validateMcpToolArguments(
        { $schema: "https://example.invalid/unsupported-dialect", type: "object" },
        {},
      ),
    ).toMatchObject({ ok: false, reason: "invalid_schema" });
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
