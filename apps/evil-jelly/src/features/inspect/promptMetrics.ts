export interface PromptUsageSample {
  promptTokens: number | undefined;
  cacheReadTokens: number | undefined;
}

export interface PromptMetrics {
  measuredCalls: number;
  cumulativeTokens: number;
  peakInputTokens: number;
  latestInputTokens: number;
  uncachedTokens: number;
  /** Estimated overlap between consecutive model inputs. */
  replayedTokens: number;
  replayShare: number;
  /** Cumulative prompt tokens divided by the largest single model input. */
  amplification: number;
}

export function projectPromptMetrics(samples: readonly PromptUsageSample[]): PromptMetrics {
  let cumulativeTokens = 0;
  let peakInputTokens = 0;
  let latestInputTokens = 0;
  let uncachedTokens = 0;
  let replayedTokens = 0;
  let previousPromptTokens: number | undefined;
  let measuredCalls = 0;

  for (const sample of samples) {
    if (sample.promptTokens === undefined) continue;
    const promptTokens = Math.max(0, sample.promptTokens);
    const cacheReadTokens = Math.max(0, sample.cacheReadTokens ?? 0);
    measuredCalls += 1;
    cumulativeTokens += promptTokens;
    peakInputTokens = Math.max(peakInputTokens, promptTokens);
    latestInputTokens = promptTokens;
    uncachedTokens += Math.max(0, promptTokens - cacheReadTokens);
    if (previousPromptTokens !== undefined) {
      replayedTokens += Math.min(previousPromptTokens, promptTokens);
    }
    previousPromptTokens = promptTokens;
  }

  return {
    measuredCalls,
    cumulativeTokens,
    peakInputTokens,
    latestInputTokens,
    uncachedTokens,
    replayedTokens,
    replayShare: cumulativeTokens > 0 ? replayedTokens / cumulativeTokens : 0,
    amplification: peakInputTokens > 0 ? cumulativeTokens / peakInputTokens : 0,
  };
}
