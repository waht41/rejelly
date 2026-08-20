import type { Message, ToolCall, ToolCallLoopContext, ToolOutput } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { createReadFileDedupMiddleware } from "./readFileDedup";

function context(messages: Message[], calls: ToolCall[]): ToolCallLoopContext {
  return {
    step: 1,
    messages,
    toolTurns: [],
    systemInstruction: null,
    instruction: null,
    originalCalls: calls,
  };
}

describe("read_file dedup middleware", () => {
  it("replaces an identical result that is still present in context", async () => {
    const prior = '<file path="a.ts" path-scope="workspace">\nconst a = 1;\n</file>';
    const calls: ToolCall[] = [
      { id: "current", name: "read_file", arguments: '{"filePaths":["a.ts"]}' },
    ];
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "prior", name: "read_file", arguments: '{"filePaths":["a.ts"]}' }],
      },
      { role: "tool", tool_call_id: "prior", content: prior },
    ];
    const middleware = createReadFileDedupMiddleware();

    const output = await middleware.handler(context(messages, calls), calls, async () => [
      { callId: "current", content: prior },
    ]);

    expect(output).toEqual([
      {
        callId: "current",
        content:
          '<file path="a.ts" path-scope="workspace" status="unchanged" reference="previous-read" />',
      },
    ]);
  });

  it("keeps changed content and error envelopes intact", async () => {
    const prior = '<file path="a.ts" path-scope="workspace">\nold\n</file>';
    const calls: ToolCall[] = [
      { id: "current", name: "read_file", arguments: '{"filePaths":["a.ts"]}' },
    ];
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "prior", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", tool_call_id: "prior", content: prior },
    ];
    const current =
      '<file path="a.ts" path-scope="workspace">\nnew\n</file>\n' +
      '<file path="b.ts" status="error">\nError: missing\n</file>';
    const middleware = createReadFileDedupMiddleware();

    const output: ToolOutput[] = await middleware.handler(
      context(messages, calls),
      calls,
      async () => [{ callId: "current", content: current }],
    );

    expect(output[0]?.content).toBe(current);
  });

  it("does not deduplicate when compaction removed the prior tool result", async () => {
    const current = '<file path="a.ts" path-scope="workspace">\nconst a = 1;\n</file>';
    const calls: ToolCall[] = [
      { id: "current", name: "read_file", arguments: '{"filePaths":["a.ts"]}' },
    ];
    const middleware = createReadFileDedupMiddleware();

    const output = await middleware.handler(context([], calls), calls, async () => [
      { callId: "current", content: current },
    ]);

    expect(output[0]?.content).toBe(current);
  });

  it("skips unchanged markers while indexing later full envelopes", async () => {
    const prior =
      '<file path="a.ts" path-scope="workspace" status="unchanged" reference="previous-read" />\n' +
      '<file path="b.ts" path-scope="workspace">\ncode\n</file>';
    const current = '<file path="b.ts" path-scope="workspace">\ncode\n</file>';
    const calls: ToolCall[] = [
      { id: "current", name: "read_file", arguments: '{"filePaths":["b.ts"]}' },
    ];
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "prior", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", tool_call_id: "prior", content: prior },
    ];
    const middleware = createReadFileDedupMiddleware();

    const output = await middleware.handler(context(messages, calls), calls, async () => [
      { callId: "current", content: current },
    ]);

    expect(output[0]?.content).toBe(
      '<file path="b.ts" path-scope="workspace" status="unchanged" reference="previous-read" />',
    );
  });

  it("round-trips escaped attributes through the shared XML-like renderer", async () => {
    const current = '<file path="a&amp;&quot;b.ts" path-scope="workspace">\ncode\n</file>';
    const calls: ToolCall[] = [
      { id: "current", name: "read_file", arguments: '{"filePaths":["a&\\"b.ts"]}' },
    ];
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "prior", name: "read_file", arguments: calls[0]!.arguments }],
      },
      { role: "tool", tool_call_id: "prior", content: current },
    ];
    const middleware = createReadFileDedupMiddleware();

    const output = await middleware.handler(context(messages, calls), calls, async () => [
      { callId: "current", content: current },
    ]);

    expect(output[0]?.content).toBe(
      '<file path="a&amp;&quot;b.ts" path-scope="workspace" status="unchanged" reference="previous-read" />',
    );
  });
});
