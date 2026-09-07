import { describe, expect, it } from "vitest";
import { normalizeOpenAIUsage } from "../usage";

describe("normalizeOpenAIUsage", () => {
  it("normalizes Chat Completions usage and compatible cache-write extensions", () => {
    expect(
      normalizeOpenAIUsage(
        {
          prompt_tokens: 43,
          completion_tokens: 516,
          total_tokens: 559,
          prompt_tokens_details: { cached_tokens: 11, cache_write_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 290 },
        },
        "chat_completions",
      ),
    ).toEqual({
      promptTokens: 43,
      completionTokens: 516,
      totalTokens: 559,
      details: { cacheReadTokens: 11, cacheWriteTokens: 7, reasoningTokens: 290 },
    });

    expect(
      normalizeOpenAIUsage(
        {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_creation_tokens: 3 },
        },
        "chat_completions",
      ),
    ).toMatchObject({ totalTokens: 12, details: { cacheWriteTokens: 3 } });
  });

  it("normalizes Responses usage without protocol inference", () => {
    expect(
      normalizeOpenAIUsage(
        {
          input_tokens: 55,
          output_tokens: 36,
          total_tokens: 91,
          input_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 16 },
          attribution: { ignored: true },
        },
        "responses",
      ),
    ).toEqual({
      promptTokens: 55,
      completionTokens: 36,
      totalTokens: 91,
      details: { cacheReadTokens: 5, cacheWriteTokens: 4, reasoningTokens: 16 },
    });
    expect(normalizeOpenAIUsage({ input_tokens: 55 }, "chat_completions")).toBeUndefined();
  });

  it("handles partial and invalid compatible shapes", () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 8 }, "chat_completions")).toEqual({
      promptTokens: 8,
      completionTokens: 0,
      totalTokens: 8,
    });
    expect(normalizeOpenAIUsage({ cost: 1 }, "responses")).toBeUndefined();
    expect(normalizeOpenAIUsage(null, "responses")).toBeUndefined();
  });
});
