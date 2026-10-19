import { describe, expect, it, vi } from "vitest";
import { equipMCP } from "./equip";
import type { MCPClientLike } from "./mcp-compat";

// Isolate composition from the Agent hook lifecycle; native calls and result conversion stay real.
vi.mock("@rejelly/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rejelly/core")>()),
  equipMemory: (_key: string, initial: unknown) => [initial, vi.fn()],
  equipMemo: (_key: string, load: () => Promise<string>) => load(),
}));

function client(overrides: Partial<MCPClientLike> = {}): MCPClientLike {
  return {
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
    ...overrides,
  };
}

async function promptsKit(listPrompts?: MCPClientLike["listPrompts"]) {
  const kit = await equipMCP(client({ listPrompts }), { clientId: "prompts-test" });
  return kit.prompts;
}

describe("MCP prompt lists", () => {
  it("collects SDK-shaped pages without losing prompt metadata", async () => {
    const first = {
      name: "first",
      description: "example",
      arguments: [{ name: "path", required: true }],
    };
    const listPrompts = vi
      .fn()
      .mockResolvedValueOnce({ prompts: [first], nextCursor: "page-2" })
      .mockResolvedValueOnce({ prompts: [{ name: "second" }] });
    const prompts = await promptsKit(listPrompts);
    expect(await prompts.list()).toEqual([first, { name: "second" }]);
    expect(listPrompts.mock.calls).toEqual([[undefined], [{ cursor: "page-2" }]]);
  });

  it("accepts legacy arrays and empty SDK pages", async () => {
    expect(await (await promptsKit(async () => [{ name: "legacy" }])).list()).toEqual([
      { name: "legacy" },
    ]);
    expect(await (await promptsKit(async () => ({ prompts: [] }))).list()).toEqual([]);
  });

  it("rejects cursor cycles, including empty pages", async () => {
    const listPrompts = vi.fn(async () => ({ prompts: [], nextCursor: "same" }));
    await expect((await promptsKit(listPrompts)).list()).rejects.toMatchObject({
      code: "cursor_cycle",
    });
    expect(listPrompts).toHaveBeenCalledTimes(2);
  });

  it("distinguishes malformed replies and invalid cursors from empty lists", async () => {
    await expect((await promptsKit(async () => ({ wrong: [] }))).list()).rejects.toMatchObject({
      code: "invalid_catalog_shape",
    });
    await expect(
      (await promptsKit(async () => ({ prompts: [], nextCursor: 123 }))).list(),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect((await promptsKit()).list()).rejects.toThrow("Client has no listPrompts()");
  });

  it("propagates page failures without retrying or returning partial results", async () => {
    const failure = new Error("page failed");
    const listPrompts = vi
      .fn()
      .mockResolvedValueOnce({ prompts: [{ name: "first" }], nextCursor: "page-2" })
      .mockRejectedValueOnce(failure);
    await expect((await promptsKit(listPrompts)).list()).rejects.toBe(failure);
    expect(listPrompts).toHaveBeenCalledTimes(2);
  });
});

describe("MCP toolkit call style", () => {
  it("passes positional style to namespaced toolkit tools", async () => {
    const callTool = vi.fn(async (..._args: unknown[]) => ({
      content: [{ type: "text", text: "done" }],
    }));
    const kit = await equipMCP(
      client({
        callTool,
        listTools: async () => [{ name: "write", inputSchema: { type: "object" } }],
      }),
      { clientId: "positional-test", namespace: "fs", callToolStyle: "positional" },
    );
    expect(await kit.toolMap.fs_write.handler({ path: "file" })).toBe("done");
    expect(callTool.mock.calls).toEqual([["write", { path: "file" }]]);
  });
});
