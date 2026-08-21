import type { TestCapabilities } from "@rejelly/test-utils";

export interface OpenAIStreamTestMatrixItem {
  /** Environment variable prefix for one independently configured model profile. */
  envId: string;
  capabilities: TestCapabilities;
}

export interface ResolvedOpenAIStreamTestConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  baseURL: string;
}

const REQUIRED_ENV_SUFFIXES = ["PROVIDER", "MODEL_ID", "API_KEY", "BASE_URL"] as const;

function envKey(envId: string, suffix: (typeof REQUIRED_ENV_SUFFIXES)[number]): string {
  return `${envId}_${suffix}`;
}

/**
 * Resolve one matrix entry from environment variables.
 *
 * A profile is disabled when none of its variables are present. Once a profile
 * is started, all variables are required so a model can never accidentally be
 * sent to an unrelated endpoint or run with a fallback model.
 */
export function resolveOpenAIStreamTestConfig(
  config: OpenAIStreamTestMatrixItem,
): ResolvedOpenAIStreamTestConfig | undefined {
  const values = Object.fromEntries(
    REQUIRED_ENV_SUFFIXES.map((suffix) => [suffix, process.env[envKey(config.envId, suffix)]]),
  ) as Record<(typeof REQUIRED_ENV_SUFFIXES)[number], string | undefined>;

  if (REQUIRED_ENV_SUFFIXES.every((suffix) => !values[suffix]?.trim())) {
    return undefined;
  }

  const missing = REQUIRED_ENV_SUFFIXES.filter((suffix) => !values[suffix]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Incomplete OpenAI adapter test profile ${config.envId}; missing: ${missing
        .map((suffix) => envKey(config.envId, suffix))
        .join(", ")}`,
    );
  }

  return {
    provider: values.PROVIDER!,
    modelId: values.MODEL_ID!,
    apiKey: values.API_KEY!,
    baseURL: values.BASE_URL!,
  };
}

export const streamTestMatrix: OpenAIStreamTestMatrixItem[] = [
  {
    envId: "OPENAI_TEST",
    capabilities: {
      basicStream: true,
      toolCall: true,
      toolChoice: true,
      nativeSchema: true,
      reasoning: false,
    },
  },
  {
    envId: "DEEPSEEK_TEST",
    capabilities: {
      basicStream: true,
      toolCall: true,
      toolChoice: false,
      nativeSchema: false,
      reasoning: true,
    },
  },
];
