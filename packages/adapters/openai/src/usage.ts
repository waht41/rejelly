import type { TokenUsage } from "@rejelly/core";

export type OpenAIUsageProtocol = "chat_completions" | "responses";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function firstTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== undefined) return count;
  }
  return undefined;
}

/** Normalize one protocol-specific OpenAI usage object into Core's stable token contract. */
export function normalizeOpenAIUsage(
  value: unknown,
  protocol: OpenAIUsageProtocol,
): TokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const inputDetails = asRecord(
    protocol === "responses" ? usage.input_tokens_details : usage.prompt_tokens_details,
  );
  const outputDetails = asRecord(
    protocol === "responses" ? usage.output_tokens_details : usage.completion_tokens_details,
  );
  const promptTokens = tokenCount(
    protocol === "responses" ? usage.input_tokens : usage.prompt_tokens,
  );
  const completionTokens = tokenCount(
    protocol === "responses" ? usage.output_tokens : usage.completion_tokens,
  );
  const reportedTotal = tokenCount(usage.total_tokens);

  if (promptTokens === undefined && completionTokens === undefined && reportedTotal === undefined) {
    return undefined;
  }

  const details = {
    cacheReadTokens: tokenCount(inputDetails?.cached_tokens),
    cacheWriteTokens:
      protocol === "responses"
        ? tokenCount(inputDetails?.cache_write_tokens)
        : firstTokenCount(inputDetails?.cache_write_tokens, inputDetails?.cached_creation_tokens),
    reasoningTokens: tokenCount(outputDetails?.reasoning_tokens),
  };
  const normalizedDetails = Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
  const normalizedPrompt = promptTokens ?? 0;
  const normalizedCompletion = completionTokens ?? 0;

  return {
    promptTokens: normalizedPrompt,
    completionTokens: normalizedCompletion,
    totalTokens: reportedTotal ?? normalizedPrompt + normalizedCompletion,
    ...(Object.keys(normalizedDetails).length > 0 && { details: normalizedDetails }),
  };
}
