import { createMockModel } from "@rejelly/core/testing";
import { describe, expect, it } from "vitest";
import { buildAnalyzeMessages, createAnalyzeAgent } from "../analyze-agent";

const TRACE_A = {
  traceId: "trace-a",
  conversationId: "conversation-1",
  activeNodeId: "node-1",
  activeNodeType: "llm",
};

const TRACE_B = {
  ...TRACE_A,
  traceId: "trace-b",
  activeNodeId: "node-2",
};

describe("analyze agent", () => {
  it("streams plain text deltas and returns the accumulated message", async () => {
    const mock = createMockModel();
    mock.when({ input: "What happened?" }).thenStream(["**Result:** ", "all good."]);
    const textDeltas: string[] = [];

    const response = await createAnalyzeAgent(mock.adapter)({
      question: "What happened?",
      history: [{ role: "user", content: "Inspect this trace." }],
      context: { traceId: "trace-1", conversationId: "conversation-1" },
      handleTextDelta: (delta) => textDeltas.push(delta),
    });

    expect(textDeltas).toEqual(["**Result:** ", "all good."]);
    expect(response.message).toBe("**Result:** all good.");
    expect(response.delta.at(-1)).toMatchObject({
      role: "assistant",
      content: "**Result:** all good.",
    });
    expect(mock.calls.last()?.schema).toBeUndefined();
  });

  it("deduplicates equal user contexts using only append-only history", () => {
    const firstRequest = buildAnalyzeMessages([], {
      question: "First question",
      context: TRACE_A,
    });
    const secondRequest = buildAnalyzeMessages(
      [
        { role: "user", content: "First question", context: { ...TRACE_A } },
        { role: "assistant", content: "First answer" },
      ],
      { question: "Second question", context: { ...TRACE_A } },
    );
    const thirdRequest = buildAnalyzeMessages(
      [
        { role: "user", content: "First question", context: { ...TRACE_A } },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question", context: { ...TRACE_A } },
        { role: "assistant", content: "Second answer" },
      ],
      { question: "Third question", context: { ...TRACE_A } },
    );

    expect(secondRequest.slice(0, firstRequest.length)).toEqual(firstRequest);
    expect(secondRequest.at(-1)).toEqual({ role: "user", content: "Second question" });
    expect(thirdRequest.slice(0, secondRequest.length)).toEqual(secondRequest);
    expect(thirdRequest.at(-1)).toEqual({ role: "user", content: "Third question" });
  });

  it("adds a new block when context changes and keeps the rebuilt prefix stable", () => {
    const secondRequest = buildAnalyzeMessages(
      [
        { role: "user", content: "First question", context: TRACE_A },
        { role: "assistant", content: "First answer" },
      ],
      { question: "Question on trace B", context: TRACE_B },
    );
    const thirdRequest = buildAnalyzeMessages(
      [
        { role: "user", content: "First question", context: TRACE_A },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Question on trace B", context: TRACE_B },
      ],
      { question: "Another question", context: TRACE_B },
    );

    expect(secondRequest.at(-1)?.content).toContain('"traceId": "trace-b"');
    expect(thirdRequest.slice(0, secondRequest.length)).toEqual(secondRequest);
    expect(thirdRequest.at(-1)).toEqual({ role: "user", content: "Another question" });
  });

  it("keeps legacy turns bare and strips all fields except role and content", () => {
    const messages = buildAnalyzeMessages(
      [
        { role: "user", content: "Old question" },
        {
          role: "assistant",
          content: "Old answer",
          reasoning_content: "internal",
          extra: { provider: "metadata" },
        },
        {
          role: "tool",
          content: "Tool result",
          tool_call_id: "call-1",
          name: "inspect",
        },
      ],
      { question: "New question" },
    );

    expect(messages).toEqual([
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "tool", content: "Tool result" },
      { role: "user", content: "New question" },
    ]);
  });

  it("uses the same static system prompt for different current contexts", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse("ok");
    const agent = createAnalyzeAgent(mock.adapter);

    await agent({ question: "First", context: TRACE_A });
    await agent({ question: "Second", context: TRACE_B });

    const systemPrompts = mock.calls
      .all()
      .map((call) => call.messages.find((message) => message.role === "system")?.content);
    expect(systemPrompts[0]).toBe(systemPrompts[1]);
    expect(systemPrompts[0]).not.toContain("trace-a");
    expect(systemPrompts[0]).not.toContain("trace-b");
  });
});
