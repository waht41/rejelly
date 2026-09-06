import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
} from "../../../shared/configuration/modelDefaults";

export type InitConfigValues = {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  protocol: "chat_completions" | "responses";
};

type InitConfigInput = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  modelId?: string | undefined;
  protocol?: string | undefined;
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

function parseProtocol(value: string): "chat_completions" | "responses" {
  const normalized = clean(value).toLowerCase();
  if (normalized === "chat_completions" || normalized === "responses") return normalized;
  throw new Error(`OPENAI_API_PROTOCOL must be chat_completions or responses; received ${value}.`);
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
  const existingProtocol = clean(existing.OPENAI_API_PROTOCOL);

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

  let protocol = clean(input.protocol);
  if (!protocol) {
    const answer = ask
      ? clean(
          await ask(
            optionalPrompt(
              "OPENAI_API_PROTOCOL (chat_completions or responses)",
              existingProtocol,
              "chat_completions",
            ),
          ),
        )
      : "";
    protocol = answer || existingProtocol || "chat_completions";
  }

  return { apiKey, baseUrl, modelId, protocol: parseProtocol(protocol) };
}
