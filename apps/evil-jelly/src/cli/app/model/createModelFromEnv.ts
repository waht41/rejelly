/** CLI model composition from the already-loaded process environment. */

import { type ChatCompletionParams, createOpenAIAdapter } from "@rejelly/adapter-openai";
import { augmentModel, type ModelAdapter } from "@rejelly/core";
import { env } from "../../../shared/configuration/env";
import { withRetry } from "./withRetry";

function isDeepSeekModelConfig(options: {
  modelId: string;
  provider: string;
  baseURL: string;
}): boolean {
  const modelId = options.modelId.trim().toLowerCase();
  const provider = options.provider.trim().toLowerCase();
  const baseURL = options.baseURL.trim().toLowerCase();
  return provider === "deepseek" || modelId.includes("deepseek") || baseURL.includes("deepseek");
}

function resolveReasoningParams(isDeepSeek: boolean): ChatCompletionParams | undefined {
  const effort = env.OPENAI_REASONING_EFFORT.trim().toLowerCase();
  if (!effort) {
    return undefined;
  }
  const params: Record<string, unknown> = { reasoning_effort: effort };
  if (isDeepSeek) {
    params.thinking = { type: effort === "none" ? "disabled" : "enabled" };
  }
  return params as ChatCompletionParams;
}

export function createOpenAIModelFromEnv(): ModelAdapter {
  const apiKey = env.OPENAI_API_KEY;
  const modelId = env.OPENAI_MODEL_ID;
  const baseURL = env.OPENAI_BASE_URL;
  const provider = env.OPENAI_PROVIDER;
  const isDeepSeek = isDeepSeekModelConfig({ modelId, provider, baseURL });
  const chatCompletionParams = resolveReasoningParams(isDeepSeek);

  const adapter = createOpenAIAdapter({
    modelId,
    baseURL,
    provider,
    apiKey,
    ...(isDeepSeek ? { schemaMode: "json_object" as const } : {}),
    ...(chatCompletionParams ? { chatCompletionParams } : {}),
  });

  return augmentModel(adapter, [withRetry({ maxAttempts: env.OPENAI_RETRY_MAX_ATTEMPTS })]);
}
