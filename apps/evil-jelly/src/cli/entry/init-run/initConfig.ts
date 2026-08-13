import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
} from "../../../shared/configuration/modelDefaults";

export type InitConfigValues = {
  apiKey: string;
  baseUrl: string;
  modelId: string;
};

type InitConfigInput = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  modelId?: string | undefined;
};

type Ask = (question: string) => Promise<string>;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function optionalPrompt(name: string, current: string, fallback: string): string {
  return current
    ? `Enter ${name} (optional; Enter to keep ${current}): `
    : `Enter ${name} (optional; Enter to use ${fallback}): `;
}

/** Resolve explicit init flags, existing global values, and optional TTY answers. */
export async function collectInitConfig(
  input: InitConfigInput,
  existing: Record<string, string>,
  ask?: Ask,
): Promise<InitConfigValues> {
  const existingApiKey = clean(existing.OPENAI_API_KEY);
  const existingBaseUrl = clean(existing.OPENAI_BASE_URL);
  const existingModelId = clean(existing.OPENAI_MODEL_ID);

  let apiKey = clean(input.apiKey);
  if (!apiKey) {
    const answer = ask
      ? clean(
          await ask(
            existingApiKey
              ? "OPENAI_API_KEY is already configured; Enter to keep it, or type a new key: "
              : "Enter OPENAI_API_KEY: ",
          ),
        )
      : "";
    apiKey = answer || existingApiKey;
  }

  let baseUrl = clean(input.baseUrl);
  if (!baseUrl) {
    const answer = ask
      ? clean(
          await ask(optionalPrompt("OPENAI_BASE_URL", existingBaseUrl, DEFAULT_OPENAI_BASE_URL)),
        )
      : "";
    baseUrl = answer || existingBaseUrl;
  }

  let modelId = clean(input.modelId);
  if (!modelId) {
    const answer = ask
      ? clean(
          await ask(optionalPrompt("OPENAI_MODEL_ID", existingModelId, DEFAULT_OPENAI_MODEL_ID)),
        )
      : "";
    modelId = answer || existingModelId;
  }

  return { apiKey, baseUrl, modelId };
}
