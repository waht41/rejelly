import { describe, expect, it } from "vitest";
import { toOpenAIMessages, wrapAsModelCallError } from "../utils";

describe("OpenAI message conversion", () => {
  it("splits multimodal tool result into a text tool message and a follow-up user message", () => {
    const messages = toOpenAIMessages([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "Image loaded." },
          { type: "image", image: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "Image loaded." },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool result content for call call_1:" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: undefined },
          },
        ],
      },
    ]);
  });

  it("uses fallback tool text when the tool returns media only", () => {
    const messages = toOpenAIMessages([
      {
        role: "tool",
        tool_call_id: "call_2",
        content: [{ type: "image", image: { url: "data:image/png;base64,AAAA" } }],
      },
    ]);

    expect(messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_2",
      content: "[Tool returned non-text content; see the following user message.]",
    });
    expect(messages[1].role).toBe("user");
  });

  it("keeps a text-only tool result as a single tool message", () => {
    const messages = toOpenAIMessages([{ role: "tool", tool_call_id: "call_3", content: "done" }]);

    expect(messages).toEqual([{ role: "tool", tool_call_id: "call_3", content: "done" }]);
  });

  it("collapses consecutive same-role messages for strict-alternation backends", () => {
    const messages = toOpenAIMessages([
      { role: "system", content: "sys-1" },
      { role: "system", content: "sys-2" },
      { role: "user", content: "turn-1" },
      { role: "user", content: "turn-2" },
      { role: "assistant", content: "reply" },
    ]);

    expect(messages).toEqual([
      { role: "system", content: "sys-1\n\nsys-2" },
      { role: "user", content: "turn-1\n\nturn-2" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("keeps user image content as multimodal Chat Completions content", () => {
    const messages = toOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "image", image: { url: "data:image/png;base64,AAAA", detail: "low" } },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "low" },
          },
        ],
      },
    ]);
  });
});

describe("OpenAI error conversion", () => {
  it("normalizes SDK abort-like errors to AbortError", () => {
    expect(() =>
      wrapAsModelCallError(
        new Error("Request was aborted."),
        "deepseek-v4-flash",
        "deepseek",
        "https://api.deepseek.com/v1",
      ),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });
});
