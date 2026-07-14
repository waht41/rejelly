import { createMockModel } from "@rejelly/core/testing";
import { describe, expect, it } from "vitest";
import { createChatAgent } from "./chat-agent";

function mockInput(messages: string[]) {
  let i = 0;
  return async () => messages[i++] ?? "";
}

describe("ChatAgent", () => {
  it("should reply to a single message and exit when model sets done", async () => {
    const mock = createMockModel();
    mock.sequence([
      { type: "json", content: { reply: "Hi there!", done: false } },
      { type: "json", content: { reply: "Bye!", done: true } },
    ]);

    const agent = createChatAgent(mock.adapter);
    const result = await agent({
      getInput: mockInput(["hello", ""]),
    });

    expect(result).toEqual({ reply: "Bye!", done: true });
    expect(mock.calls.count()).toBe(2);
  });

  it("should carry conversation history across reborn turns", async () => {
    const mock = createMockModel();
    mock.sequence([
      { type: "json", content: { reply: "Hello! How can I help?", done: false } },
      { type: "json", content: { reply: "TypeScript is great!", done: false } },
      { type: "json", content: { reply: "Bye!", done: true } },
    ]);

    const agent = createChatAgent(mock.adapter);
    const result = await agent({
      getInput: mockInput(["hi", "tell me about TypeScript", ""]),
    });

    expect(result).toEqual({ reply: "Bye!", done: true });
    expect(mock.calls.count()).toBe(3);

    const secondCall = mock.calls.all()[1];
    const contentOf = (m: { content: unknown }) => {
      const c = m.content;
      if (c == null) return "";
      if (typeof c === "string") return c;
      return (c as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text" && "text" in part)
        .map((part) => part.text)
        .join("");
    };

    // History is carried as real chat messages, not instruction text
    const userMessages = secondCall.messages.filter((m) => m.role === "user").map(contentOf);
    const assistantMessages = secondCall.messages
      .filter((m) => m.role === "assistant")
      .map(contentOf);

    expect(userMessages).toContain("hi");
    expect(userMessages).toContain("tell me about TypeScript");
    // The assistant turn is replayed as the model's actual output (the schema JSON
    // envelope), not a bare reply string, so the reply appears inside that JSON.
    expect(assistantMessages.some((m) => m.includes("Hello! How can I help?"))).toBe(true);
  });

  it("should exit when model returns done on empty input", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ reply: "Bye!", done: true });

    const agent = createChatAgent(mock.adapter);
    const result = await agent({
      getInput: mockInput([""]),
    });

    expect(result).toEqual({ reply: "Bye!", done: true });
    expect(mock.calls.count()).toBe(1);
  });

  it("should use conditional responses via mock.when()", async () => {
    const mock = createMockModel();
    // Match only the latest user message; history now repeats earlier inputs as
    // real chat messages, so a plain `input` match would also hit later turns
    mock
      .when(({ lastUserMessage }) => /weather/.test(lastUserMessage ?? ""))
      .thenReturn({ reply: "It is sunny today!", done: false });
    mock.setDefaultResponse({ reply: "I am not sure.", done: true });

    const agent = createChatAgent(mock.adapter);
    const result = await agent({
      getInput: mockInput(["what's the weather", ""]),
    });

    expect(result).toEqual({ reply: "I am not sure.", done: true });
    expect(mock.calls.count()).toBe(2);
  });
});
