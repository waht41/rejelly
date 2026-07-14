/**
 * Model pricing tables and calculateCost factories for examples.
 * Scalars are vendor CNY or USD per 1M tokens; numerically equal to micro CNY/USD per token.
 *
 * SAMPLE ONLY — these rates are illustrative and are NOT guaranteed accurate or
 * up to date. They exist to show how to wire a `calculateCost` into an adapter;
 * always consult each vendor's official pricing and maintain your own table for
 * any real cost reporting. The shipped apps deliberately omit cost calculation.
 */

import type { TokenUsage } from "@rejelly/core";

/** Per-model pricing. Omit unit for micro_usd; set unit for other billing keys (e.g. micro_cny). */
export type ModelPricingEntry = {
  input: number;
  output: number;
  /** Cache-hit input rate (same numeric form as input); omit if not priced separately. */
  input_cache?: number;
  /** Cache-write input rate (same numeric form as input); omit if not priced separately. */
  input_cache_write?: number;
  /** Result key for calculateCost; defaults to micro_usd. */
  unit?: string;
};

// ── Model pricing ──────────────────────────────────────────────────────────

export const MODEL_PRICING: Record<string, ModelPricingEntry> = {
  "deepseek-chat": {
    unit: "micro_cny",
    input: 2,
    input_cache: 0.2,
    output: 3,
  },
  "deepseek-reasoner": {
    unit: "micro_cny",
    input: 2,
    input_cache: 0.2,
    output: 3,
  },
  "gpt-5.6": { input: 5.0, input_cache: 0.5, input_cache_write: 6.25, output: 30.0 },
  "gpt-5.6-sol": { input: 5.0, input_cache: 0.5, input_cache_write: 6.25, output: 30.0 },
  "gpt-5.6-terra": { input: 2.5, input_cache: 0.25, input_cache_write: 3.125, output: 15.0 },
  "gpt-5.6-luna": { input: 1.0, input_cache: 0.1, input_cache_write: 1.25, output: 6.0 },
  "gpt-5.5": { input: 5.0, input_cache: 0.5, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, output: 180.0 },
  "gpt-5.4": { input: 2.5, input_cache: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, input_cache: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, input_cache: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30.0, output: 180.0 },
  "gpt-5.3-codex": { input: 1.75, input_cache: 0.175, output: 14.0 },
  "claude-fable-5": { input: 10.0, input_cache: 1.0, input_cache_write: 12.5, output: 50.0 },
  "claude-mythos-5": { input: 10.0, input_cache: 1.0, input_cache_write: 12.5, output: 50.0 },
  "claude-opus-4-8": { input: 5.0, input_cache: 0.5, input_cache_write: 6.25, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, input_cache: 0.5, input_cache_write: 6.25, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, input_cache: 0.5, input_cache_write: 6.25, output: 25.0 },
  "claude-opus-4-5": { input: 5.0, input_cache: 0.5, input_cache_write: 6.25, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, input_cache: 0.2, input_cache_write: 2.5, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, input_cache: 0.3, input_cache_write: 3.75, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, input_cache: 0.3, input_cache_write: 3.75, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, input_cache: 0.1, input_cache_write: 1.25, output: 5.0 },
  "claude-haiku-4-5-20251001": {
    input: 1.0,
    input_cache: 0.1,
    input_cache_write: 1.25,
    output: 5.0,
  },
  "gemini-3.5-flash": { input: 1.5, input_cache: 0.15, output: 9.0 },
  "gemini-3.1-pro-preview": { input: 2.0, input_cache: 0.2, output: 12.0 },
  "gemini-3.1-flash-lite": { input: 0.25, input_cache: 0.025, output: 1.5 },
  "gemini-3-flash-preview": { input: 0.5, input_cache: 0.05, output: 3.0 },
  "gemini-2.5-pro": { input: 1.25, input_cache: 0.125, output: 10.0 },
  "gemini-2.5-flash": { input: 0.3, input_cache: 0.03, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, input_cache: 0.01, output: 0.4 },
};

function promptCostMicro(usage: TokenUsage, p: ModelPricingEntry): number {
  const cacheRead = usage.details?.cacheReadTokens;
  const cacheWrite = usage.details?.cacheWriteTokens;
  const read =
    p.input_cache !== undefined && typeof cacheRead === "number" && cacheRead > 0
      ? Math.min(cacheRead, usage.promptTokens)
      : 0;
  const writablePromptTokens = usage.promptTokens - read;
  const write =
    p.input_cache_write !== undefined && typeof cacheWrite === "number" && cacheWrite > 0
      ? Math.min(cacheWrite, writablePromptTokens)
      : 0;
  const miss = usage.promptTokens - read - write;
  return (
    miss * p.input + read * (p.input_cache ?? p.input) + write * (p.input_cache_write ?? p.input)
  );
}

export function createCalculateCost(
  modelId: string,
): (usage: TokenUsage) => Record<string, number> {
  return (usage: TokenUsage): Record<string, number> => {
    const p = MODEL_PRICING[modelId];
    if (!p) return {};
    // Same scalar as per-1M token quote is micro per token; /1e6 and *1e6 cancel.
    const micro = Math.round(promptCostMicro(usage, p) + usage.completionTokens * p.output);
    const key = p.unit ?? "micro_usd";
    return micro === 0 ? {} : { [key]: micro };
  };
}
