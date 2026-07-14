import { describe, expect, it, vi } from "vitest";
import { createGeminiAdapter } from "../adapter";

const mocks = vi.hoisted(() => ({
  generateContentStream: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  FinishReason: {
    STOP: "STOP",
    MAX_TOKENS: "MAX_TOKENS",
    SAFETY: "SAFETY",
  },
  GoogleGenAI: vi.fn(
    class {
      models = {
        generateContentStream: mocks.generateContentStream,
      };
    },
  ),
}));

async function* streamChunks(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("Gemini usage metadata", () => {
  it("counts thoughtsTokenCount as completionTokens and reasoningTokens detail", async () => {
    mocks.generateContentStream.mockReturnValue(
      streamChunks([
        {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 17,
            thoughtsTokenCount: 23,
            totalTokenCount: 51,
          },
        },
      ]),
    );

    const adapter = createGeminiAdapter({
      modelId: "gemini-test",
      apiKey: "test-key",
    });

    const events = [];
    for await (const event of adapter.stream([{ role: "user", content: "hello" }])) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "usage",
      usage: {
        promptTokens: 11,
        completionTokens: 40,
        totalTokens: 51,
        details: {
          reasoningTokens: 23,
        },
      },
    });
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: {
        promptTokens: 11,
        completionTokens: 40,
        totalTokens: 51,
        details: {
          reasoningTokens: 23,
        },
      },
    });
  });
});
