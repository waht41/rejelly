/**
 * Tests for withToolLogger: captures result, calls logToolBlock, stringifies objects, truncates preview.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvilJellyHostBindings } from "../types";

// Hoisted: mockGetBinding is available during vi.mock factory hoisting.
const { mockGetBinding } = vi.hoisted(() => ({
  mockGetBinding: vi.fn<() => EvilJellyHostBindings>(),
}));

vi.mock("../host/hostBindings", () => ({
  getBinding: () => mockGetBinding(),
}));

import { getActiveToolCall, recordActiveToolDetail } from "./invocationContext";
import { withToolLogger } from "./middleware";

describe("withToolLogger", () => {
  function createMockBindings(): EvilJellyHostBindings & {
    printed: Array<{ message: string }>;
    toolBlocks: Array<{
      id?: string;
      ordinal?: number;
      toolName: string;
      summary: string;
      args?: string;
      detail?: { type: "diff"; text: string; caption?: string };
      preview: string;
      fullResult: string;
      ok: boolean;
    }>;
  } {
    const printed: Array<{ message: string }> = [];
    const toolBlocks: Array<{
      id?: string;
      ordinal?: number;
      toolName: string;
      summary: string;
      args?: string;
      detail?: { type: "diff"; text: string; caption?: string };
      preview: string;
      fullResult: string;
      ok: boolean;
    }> = [];
    return {
      printed,
      toolBlocks,
      getInput: async () => ({ text: "" }),
      printOut: (msg: string) => {
        printed.push({ message: msg });
      },
      logUserMessage: () => {},
      logAssistantMessage: () => {},
      logSystemEvent: () => {},
      logToolBlock: (block) => {
        toolBlocks.push(block);
      },
      confirmTool: async () => ({ action: "accept" as const }),
      requestChoice: async () => "",
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls printOut with summary and logToolBlock with result on success", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "read_file",
      input: { filePaths: ["src/a.ts"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const next = vi.fn().mockResolvedValue("file content line 1\nline 2\nline 3");
    const result = await middleware.handler!(ctx, next);

    expect(result).toBe("file content line 1\nline 2\nline 3");
    expect(mockGetBinding).toHaveBeenCalled();
    // No logToolStart on these bindings, so the middleware falls back to the
    // one-line announcement.
    expect(bindings.printed.length).toBeGreaterThanOrEqual(1);
    expect(bindings.printed[0]?.message).toContain("[Tools] read_file");
    expect(bindings.toolBlocks).toHaveLength(1);
    const block = bindings.toolBlocks[0]!;
    expect(block.toolName).toBe("read_file");
    expect(block.ok).toBe(true);
    expect(block.summary).toContain("[Tools] read_file");
    expect(block.args).toContain('"filePaths"');
    expect(block.args).toContain('"src/a.ts"');
    expect(block.fullResult).toBe("file content line 1\nline 2\nline 3");
    expect(block.preview).toContain("file content line 1");
  });

  it("calls logToolBlock on tool handler failure with ok=false", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "run_command",
      input: { command: "invalid-command" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const next = vi.fn().mockRejectedValue(new Error("Command failed with exit code 1"));

    await expect(middleware.handler!(ctx, next)).rejects.toThrow("Command failed with exit code 1");

    expect(bindings.toolBlocks).toHaveLength(1);
    const block = bindings.toolBlocks[0]!;
    expect(block.toolName).toBe("run_command");
    expect(block.ok).toBe(false);
    expect(block.fullResult).toBe("Command failed with exit code 1");
  });

  it("stringifies object results before passing to logToolBlock", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "ast_document_symbols",
      input: { filePath: "src/a.ts" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const next = vi.fn().mockResolvedValue({
      symbols: [{ name: "Foo", kind: "class", line: 10 }],
    });

    await middleware.handler!(ctx, next);

    expect(bindings.toolBlocks).toHaveLength(1);
    const block = bindings.toolBlocks[0]!;
    expect(block.fullResult).toContain('"Foo"');
    expect(block.fullResult).toContain('"class"');
  });

  it("truncates preview to 6 lines / 600 chars", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "read_file",
      input: { filePaths: ["src/long.ts"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const next = vi.fn().mockResolvedValue(longContent);

    await middleware.handler!(ctx, next);

    expect(bindings.toolBlocks).toHaveLength(1);
    const block = bindings.toolBlocks[0]!;
    expect(block.fullResult.split("\n").length).toBe(20);
    expect(block.preview.split("\n").length).toBeLessThanOrEqual(7);
    expect(block.preview.endsWith("…")).toBe(true);
    expect(block.preview).toContain("line 1");
  });

  it("keeps generic Agent tool arguments in the tool block", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "Agent",
      input: {
        task: "Inspect the code path",
        prompt: "line 1\nline 2\nline 3",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await middleware.handler!(ctx, vi.fn().mockResolvedValue("done"));

    const block = bindings.toolBlocks[0]!;
    expect(block.args).toContain('"task": "Inspect the code path"');
    expect(block.args).toContain("line 1\\nline 2\\nline 3");
  });

  it("summarizes Write tool content in arguments", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "Write",
      input: {
        filePath: "src/generated.ts",
        content: "first\nsecond\nthird",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await middleware.handler!(ctx, vi.fn().mockResolvedValue("done"));

    const block = bindings.toolBlocks[0]!;
    expect(block.args).toContain('"filePath": "src/generated.ts"');
    expect(block.args).toContain('"content": "<omitted: 18 chars, 3 lines>"');
    expect(block.args).not.toContain("first\\nsecond\\nthird");
  });

  it("attaches tool details recorded while the handler runs", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const ctx = {
      toolName: "edit_file",
      input: { targets: [{ filePath: "a.ts", edits: [] }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const next = vi.fn().mockImplementation(async () => {
      recordActiveToolDetail({ type: "diff", text: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n" });
      return "Updated a.ts.";
    });

    await middleware.handler!(ctx, next);

    expect(bindings.toolBlocks[0]?.detail).toEqual({
      type: "diff",
      text: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n",
    });
  });

  it("flattens a multi-line command into a one-row headline", async () => {
    const bindings = createMockBindings();
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const command = "node <<'EOF'\n  console.log(1);\n  console.log(2);\nEOF";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = { toolName: "run_command", input: { command } } as any;

    await middleware.handler!(ctx, vi.fn().mockResolvedValue("ok"));

    const block = bindings.toolBlocks[0]!;
    expect(block.summary).not.toContain("\n");
    expect(block.summary).toBe(
      "[Tools] run_command → node <<'EOF' console.log(1); console.log(2); EOF",
    );
    // The exact text stays recoverable from the arguments.
    expect(JSON.parse(block.args!).command).toBe(command);
  });

  it("hands the call handle to the running handler and back on the block", async () => {
    const bindings = createMockBindings();
    bindings.logToolStart = () => ({ id: "tc_1", ordinal: 7 });
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = { toolName: "run_command", input: { command: "pnpm build" } } as any;

    let seen: ReturnType<typeof getActiveToolCall>;
    const next = vi.fn().mockImplementation(async () => {
      seen = getActiveToolCall();
      return "ok";
    });

    await middleware.handler!(ctx, next);

    // A streaming handler reads this to attribute its output to the right tool.
    expect(seen).toEqual({ id: "tc_1", ordinal: 7 });
    expect(bindings.toolBlocks[0]).toMatchObject({ id: "tc_1", ordinal: 7 });
    // The live view replaces the one-line announcement.
    expect(bindings.printed).toHaveLength(0);
  });

  it("keeps parallel calls on their own handles", async () => {
    const bindings = createMockBindings();
    let next_ordinal = 0;
    bindings.logToolStart = () => {
      next_ordinal++;
      return { id: `tc_${next_ordinal}`, ordinal: next_ordinal };
    };
    mockGetBinding.mockReturnValue(bindings);

    const middleware = withToolLogger();
    const seen: Array<number | undefined> = [];
    const run = (command: string, delayMs: number) =>
      middleware.handler!(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { toolName: "run_command", input: { command } } as any,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          seen.push(getActiveToolCall()?.ordinal);
          return "ok";
        },
      );

    // The second call finishes first; AsyncLocalStorage must keep the slots apart.
    await Promise.all([run("slow", 20), run("fast", 0)]);

    expect(seen).toEqual([2, 1]);
    expect(bindings.toolBlocks.map((block) => block.ordinal)).toEqual([2, 1]);
  });
});
