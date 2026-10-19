import { toolContent } from "@rejelly/core";
import { describe, expect, it, vi } from "vitest";
import type { MCPClientLike } from "./mcp-compat";
import { formatCallToolResult, normalizeCallTool, normalizeListTools } from "./mcp-compat";
import type { CallToolResult } from "./types";

function client(overrides: Partial<MCPClientLike> = {}): MCPClientLike {
  return {
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
    ...overrides,
  };
}

const descriptor = (name: string) => ({ name, inputSchema: { type: "object" } });

describe("MCP compatibility calls", () => {
  it("uses the SDK signature once and preserves the client binding", async () => {
    const result = { content: [{ type: "text", text: "done" }] };
    const callTool = vi.fn(async function (this: MCPClientLike, ..._args: unknown[]) {
      expect(this).toBe(connection);
      return result;
    });
    const connection = client({ callTool });
    expect(await normalizeCallTool(connection, "write", { path: "file" })).toBe(result);
    expect(callTool.mock.calls).toEqual([[{ name: "write", arguments: { path: "file" } }]]);
  });

  it("supports explicitly selected positional calls without probing", async () => {
    const callTool = vi.fn(async (..._args: unknown[]) => ({ content: [] }));
    await normalizeCallTool(client({ callTool }), "write", { path: "file" }, "positional");
    expect(callTool.mock.calls).toEqual([["write", { path: "file" }]]);
  });

  it.each([
    "object",
    "positional",
  ] as const)("does not retry %s calls after a lost mutation response", async (style) => {
    const failure = new Error("response lost after mutation");
    let executions = 0;
    const callTool = vi.fn(async (..._args: unknown[]) => {
      executions++;
      throw failure;
    });
    await expect(normalizeCallTool(client({ callTool }), "write", {}, style)).rejects.toBe(failure);
    expect(executions).toBe(1);
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("does not retry malformed responses or native tool errors", async () => {
    const callTool = vi.fn(async (..._args: unknown[]) => ({ unexpected: true }));
    await expect(normalizeCallTool(client({ callTool }), "write", {})).rejects.toThrow(
      "Unexpected callTool()",
    );
    expect(callTool).toHaveBeenCalledOnce();
    const nativeError = { content: [{ type: "text", text: "denied" }], isError: true };
    const failingClient = client({ callTool: vi.fn(async () => nativeError) });
    expect(await normalizeCallTool(failingClient, "write", {})).toBe(nativeError);
    expect(failingClient.callTool).toHaveBeenCalledOnce();
  });
});

describe("MCP compatibility pagination", () => {
  it("follows SDK pages and still accepts legacy arrays", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor("first")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ tools: [descriptor("second")] });
    expect((await normalizeListTools(client({ listTools }))).map((tool) => tool.name)).toEqual([
      "first",
      "second",
    ]);
    expect(listTools.mock.calls).toEqual([[], [{ cursor: "page-2" }]]);
    expect(
      await normalizeListTools(client({ listTools: async () => [descriptor("legacy")] })),
    ).toEqual([descriptor("legacy")]);
  });

  it.each([
    undefined,
    ["missing"],
  ])("rejects cursor cycles even when no new names are collected (%s)", async (requiredNames) => {
    const listTools = vi.fn(async () => ({ tools: [descriptor("same")], nextCursor: "repeated" }));
    await expect(
      normalizeListTools(client({ listTools }), { maxItems: 2, requiredNames }),
    ).rejects.toMatchObject({ code: "cursor_cycle" });
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("does not restart pagination after a page request fails", async () => {
    const failure = new Error("page failed");
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor("first")], nextCursor: "page-2" })
      .mockRejectedValueOnce(failure);
    await expect(normalizeListTools(client({ listTools }))).rejects.toBe(failure);
    expect(listTools.mock.calls).toEqual([[], [{ cursor: "page-2" }]]);
  });

  it("honors first-page mode, required names, and the distinct-tool limit", async () => {
    const listTools = vi.fn(async () => ({
      tools: [descriptor("first"), descriptor("second")],
      nextCursor: "next",
    }));
    expect((await normalizeListTools(client({ listTools }), { autoPaginate: false })).length).toBe(
      2,
    );
    expect(listTools).toHaveBeenCalledOnce();
    expect(await normalizeListTools(client({ listTools }), { requiredNames: ["second"] })).toEqual([
      descriptor("second"),
    ]);
    await expect(
      normalizeListTools(client({ listTools }), { requiredNames: ["second"], maxItems: 1 }),
    ).rejects.toThrow("maxItems");
    expect(await normalizeListTools(client({ listTools }), { maxItems: 1 })).toEqual([
      descriptor("first"),
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid maxItems %s before I/O", async (maxItems) => {
    const connection = client();
    await expect(normalizeListTools(connection, { maxItems })).rejects.toMatchObject({
      code: "invalid_catalog_limit",
    });
    expect(connection.listTools).not.toHaveBeenCalled();
  });

  it("rejects malformed pages and cursors", async () => {
    await expect(normalizeListTools(client({ listTools: async () => ({}) }))).rejects.toMatchObject(
      { code: "invalid_catalog_shape" },
    );
    await expect(
      normalizeListTools(client({ listTools: async () => ({ tools: [], nextCursor: 123 }) })),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

describe("MCP compatibility result formatting", () => {
  it("keeps ordinary text results unchanged", () => {
    expect(
      formatCallToolResult({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("preserves structured results with text or an empty content list", () => {
    for (const content of [[], [{ type: "text", text: "completed" }]]) {
      const result: CallToolResult = { content, structuredContent: { count: 42 } };
      expect(formatCallToolResult(result)).toBe(result);
    }
  });

  it("keeps multimodal delivery while including structured data", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    expect(formatCallToolResult({ content: [image], structuredContent: { count: 42 } })).toEqual(
      toolContent([
        { type: "image", image: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: '{"count":42}' },
      ]),
    );
    expect(formatCallToolResult({ content: [image] })).toEqual(
      toolContent([{ type: "image", image: { url: "data:image/png;base64,AAAA" } }]),
    );
  });

  it("continues to surface native tool errors", () => {
    expect(() =>
      formatCallToolResult({ content: [{ type: "text", text: "denied" }], isError: true }),
    ).toThrow("MCP tool error: denied");
  });
});
