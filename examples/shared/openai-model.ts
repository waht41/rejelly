/**
 * OpenAI model factory for examples.
 * Env (dotenv + optional proxy) is loaded by the runner via
 * `tsx --import @rejelly/env/setup` before this module is imported.
 *
 * Env is read lazily inside the getter — NOT at module top level — because
 * this module is imported (via @shared/runtime-model) during example
 * discovery for every module. Requiring OpenAI config at import time would
 * break all examples for users who only configured the Gemini provider.
 */

import { createOpenAIAdapter } from "@rejelly/adapter-openai";
import type { ModelAdapter } from "@rejelly/core";
import { createCalculateCost } from "./model-pricing";

let cachedOpenAIModel: ModelAdapter | undefined;

export function getOpenAIModel(): ModelAdapter {
  if (!cachedOpenAIModel) {
    const modelId = process.env.OPENAI_MODEL_ID ?? process.env.MODEL_ID;
    if (!modelId) {
      throw new Error("OPENAI_MODEL_ID or MODEL_ID is not set in environment variables");
    }
    cachedOpenAIModel = createOpenAIAdapter({
      modelId,
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      provider: process.env.OPENAI_PROVIDER,
      calculateCost: createCalculateCost(modelId),
    });
  }
  return cachedOpenAIModel;
}
