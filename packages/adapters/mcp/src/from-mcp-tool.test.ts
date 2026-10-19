import { describe, expect, it, vi } from "vitest";
import { fromMCPTool } from "./from-mcp-tool";

const client = () => ({
  callTool: vi.fn(async (..._args: unknown[]) => ({ content: [{ type: "text", text: "done" }] })),
  listTools: vi.fn(async () => []),
});

describe("fromMCPTool dynamic object parameters", () => {
  it("preserves nested dictionaries through parameter parsing and native invocation", async () => {
    const connection = client();
    const tool = fromMCPTool(
      {
        name: "query",
        inputSchema: {
          type: "object",
          properties: {
            headers: { type: "object", additionalProperties: { type: "string" } },
            batches: {
              type: "array",
              items: { type: "object", additionalProperties: { type: "number" } },
            },
          },
          required: ["headers"],
        },
      },
      connection,
    );
    const args = {
      headers: { Authorization: "example", Accept: "application/json" },
      batches: [{ first: 1, second: 2 }],
      extra: true,
    };
    const parsed = tool.parameters.parse(args);
    expect(parsed).toEqual(args);
    expect(parsed).not.toBe(args);
    await tool.handler(parsed);
    expect(connection.callTool).toHaveBeenCalledWith({ name: "query", arguments: args });
    expect(tool.parameters.safeParse({ headers: { invalid: 123 } }).success).toBe(false);
    expect(tool.parameters.safeParse({ headers: {}, batches: [{ invalid: "text" }] }).success).toBe(
      false,
    );
  });

  it.each([
    undefined,
    true,
  ])("preserves additional properties when additionalProperties is %s", (additionalProperties) => {
    const tool = fromMCPTool(
      {
        name: "query",
        inputSchema: {
          type: "object",
          properties: {
            payload: {
              type: "object",
              properties: { known: { type: "string" } },
              additionalProperties,
            },
          },
          additionalProperties,
        },
      },
      client(),
    );
    const args = { extra: 1, payload: { known: "yes", dynamic: { nested: [1, true, null] } } };
    expect(tool.parameters.parse(args)).toEqual(args);
  });

  it("enforces additionalProperties schemas at the root", () => {
    const tool = fromMCPTool(
      {
        name: "dictionary",
        inputSchema: { type: "object", additionalProperties: { type: "string" } },
      },
      client(),
    );
    expect(tool.parameters.parse({ key: "value" })).toEqual({ key: "value" });
    expect(tool.parameters.safeParse({ key: 123 }).success).toBe(false);
  });

  it("rejects additional properties where explicitly forbidden without stripping valid data", () => {
    const tool = fromMCPTool(
      {
        name: "strict",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            payload: {
              type: "object",
              additionalProperties: false,
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
          required: ["payload"],
        },
      },
      client(),
    );
    expect(tool.parameters.parse({ payload: { value: "ok" } })).toEqual({
      payload: { value: "ok" },
    });
    expect(tool.parameters.safeParse({ payload: { value: "ok", extra: true } }).success).toBe(
      false,
    );
    expect(tool.parameters.safeParse({ payload: { value: "ok" }, extra: true }).success).toBe(
      false,
    );
    expect(tool.parameters.safeParse({ payload: {} }).success).toBe(false);
  });

  it("forwards the explicit positional style and keeps the native name when namespaced", async () => {
    const connection = client();
    const tool = fromMCPTool({ name: "write", inputSchema: { type: "object" } }, connection, {
      name: "fs_write",
      callToolStyle: "positional",
    });
    expect(tool.name).toBe("fs_write");
    await tool.handler(tool.parameters.parse({ path: "file" }));
    expect(connection.callTool.mock.calls).toEqual([["write", { path: "file" }]]);
  });
});
