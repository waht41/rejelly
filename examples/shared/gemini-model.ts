/**
 * Gemini model factory for examples.
 * Env (dotenv + optional proxy) is loaded by the runner via
 * `tsx --import @rejelly/env/setup` before this module is imported.
 *
 * Env is read lazily inside the getters — NOT at module top level — because
 * this module is imported (via @shared/runtime-model) during example
 * discovery for every module. Requiring GEMINI keys at import time would
 * break all examples for users who only configured the OpenAI provider.
 */

import { createGeminiAdapter, type GeminiAdapterConfig } from "@rejelly/adapter-gemini";
import type { ModelAdapter } from "@rejelly/core";
import { createCalculateCost } from "./model-pricing";

function requireEnv(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function getGeminiEnv(): { apiKey: string; modelId: string } {
  return {
    apiKey: requireEnv(
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
      "GEMINI_API_KEY or GOOGLE_API_KEY is not set in environment variables",
    ),
    modelId: requireEnv(
      process.env.GEMINI_MODEL_ID ?? process.env.MODEL_ID,
      "GEMINI_MODEL_ID or MODEL_ID is not set in environment variables",
    ),
  };
}

let cachedGeminiModel: ModelAdapter | undefined;

export function getGeminiModel(): ModelAdapter {
  if (!cachedGeminiModel) {
    const { apiKey, modelId } = getGeminiEnv();
    cachedGeminiModel = createGeminiAdapter({
      modelId,
      apiKey,
      calculateCost: createCalculateCost(modelId),
      generateContentParams: {
        thinkingConfig: {
          includeThoughts: true,
        },
      },
    });
  }
  return cachedGeminiModel;
}

export function createGeminiModel(config?: GeminiAdapterConfig): ModelAdapter {
  const env = getGeminiEnv();
  const modelId = config?.modelId ?? env.modelId;
  return createGeminiAdapter({
    modelId: env.modelId,
    apiKey: env.apiKey,
    ...config,
    calculateCost: config?.calculateCost ?? createCalculateCost(modelId),
  });
}
