/** CLI model composition from the already-loaded process environment. */

import {
  type ChatCompletionParams,
  createOpenAIAdapter,
  type ResponseParams,
} from "@rejelly/adapter-openai";
import { augmentModel, type ModelAdapter } from "@rejelly/core";
import { env } from "../../shared/configuration/env";
import { registerSessionModelConfiguration } from "../../shared/model/observation/modelConfiguration";
import { withModelInputMetrics } from "../../shared/model/observation/modelInputMetrics";
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

function resolveChatReasoningParams(
  effort: string,
  isDeepSeek: boolean,
): ChatCompletionParams | undefined {
  if (!effort) return undefined;
  const params: Record<string, unknown> = { reasoning_effort: effort };
  if (isDeepSeek) {
    params.thinking = { type: effort === "none" ? "disabled" : "enabled" };
  }
  return params as ChatCompletionParams;
}

function resolveResponseParams(effort: string): ResponseParams | undefined {
  return effort ? ({ reasoning: { effort } } as ResponseParams) : undefined;
}

export function createOpenAIModelFromEnv(): ModelAdapter {
  const apiKey = env.OPENAI_API_KEY;
  const modelId = env.OPENAI_MODEL_ID;
  const baseURL = env.OPENAI_BASE_URL;
  const provider = env.OPENAI_PROVIDER;
  const protocol = env.OPENAI_API_PROTOCOL;
  const effort = env.OPENAI_REASONING_EFFORT.trim().toLowerCase();
  const isDeepSeek = isDeepSeekModelConfig({ modelId, provider, baseURL });
  const sharedConfig = {
    modelId,
    baseURL,
    provider,
    apiKey,
    // Evil owns model-call retries so one logical attempt cannot multiply with
    // the OpenAI SDK's default retries (and any retries performed by a gateway).
    // Bound stalled requests so the CLI cannot remain at Connect indefinitely.
    requestOption: { maxRetries: 0, timeout: 30_000 },
    ...(isDeepSeek ? { schemaMode: "json_object" as const } : {}),
  };

  const responseParams = resolveResponseParams(effort);
  const chatCompletionParams = resolveChatReasoningParams(effort, isDeepSeek);
  const adapter =
    protocol === "responses"
      ? createOpenAIAdapter({
          ...sharedConfig,
          api: "responses",
          ...(responseParams ? { responseParams } : {}),
        })
      : createOpenAIAdapter({
          ...sharedConfig,
          api: "chat_completions",
          ...(chatCompletionParams ? { chatCompletionParams } : {}),
        });

  const model = augmentModel(adapter, [
    withModelInputMetrics(),
    withRetry({ maxAttempts: env.OPENAI_RETRY_MAX_ATTEMPTS }),
  ]);
  return registerSessionModelConfiguration(model, {
    modelId,
    provider,
    protocol,
    endpoint: baseURL,
    ...(effort ? { reasoningEffort: effort } : {}),
  });
}
