/**
 * Tests for withToolLogger: captures result, calls logToolBlock, stringifies objects, truncates preview.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvilJellyHostBindings } from "../../shared/types";

// Hoisted: mockGetBinding is available during vi.mock factory hoisting.
const { mockGetBinding } = vi.hoisted(() => ({
  mockGetBinding: vi.fn<() => EvilJellyHostBindings>(),
}));

vi.mock("../../services/binding/hostBindings", () => ({
  getBinding: () => mockGetBinding(),
}));

import { recordActiveToolDetail } from "../../services/binding/toolTranscriptDetail";
import { withToolLogger } from "./withToolLogger";

describe("withToolLogger", () => {
  function createMockBindings(): EvilJellyHostBindings & {
    printed: Array<{ message: string; kind: "assistant" | "tool-progress" | undefined }>;
    toolBlocks: Array<{
      toolName: string;
      summary: string;
      args?: string;
      detail?: { type: "diff"; text: string; caption?: string };
      preview: string;
      fullResult: string;
      ok: boolean;
    }>;
  } {
    const printed: Array<{ message: string; kind: "assistant" | "tool-progress" | undefined }> = [];
    const toolBlocks: Array<{
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
      printOut: (msg, options) => {
        printed.push({ message: msg, kind: options?.kind });
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
    expect(bindings.printed.length).toBeGreaterThanOrEqual(1);
    expect(bindings.printed[0]?.message).toContain("[Tools] read_file");
    expect(bindings.printed[0]?.kind).toBe("tool-progress");
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
});
