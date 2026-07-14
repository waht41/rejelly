/**
 * Resolve model adapter for examples from environment variables.
 */

import type { ModelAdapter } from "@rejelly/core";
import { getGeminiModel } from "./gemini-model";
import { getOpenAIModel } from "./openai-model";

type RuntimeModelProvider = "openai" | "gemini";

let cachedModel: ModelAdapter | undefined;

function getProviderFromEnv(): RuntimeModelProvider {
  const rawProvider = process.env.EXAMPLE_MODEL_PROVIDER ?? process.env.MODEL_PROVIDER;
  const provider = rawProvider?.trim().toLowerCase();

  if (!provider || provider === "openai") return "openai";
  if (provider === "gemini") return "gemini";

  throw new Error(
    `Invalid model provider: "${rawProvider}". Set EXAMPLE_MODEL_PROVIDER or MODEL_PROVIDER to "openai" or "gemini".`,
  );
}

export function getModel(): ModelAdapter {
  if (cachedModel) return cachedModel;

  const provider = getProviderFromEnv();
  cachedModel = provider === "gemini" ? getGeminiModel() : getOpenAIModel();
  return cachedModel;
}
