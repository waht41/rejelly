import type { TestCapabilities } from "@rejelly/test-utils";

export interface OpenAIStreamTestMatrixItem {
  envId: string;
  provider: string;
  modelId: string;
  envVarKey: string;
  baseURL?: string;
  capabilities: TestCapabilities;
}

export const streamTestMatrix: OpenAIStreamTestMatrixItem[] = [
  {
    envId: "env_openai_gpt56_luna",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    envVarKey: "OPENAI_API_KEY",
    capabilities: {
      basicStream: true,
      toolCall: true,
      toolChoice: true,
      nativeSchema: true,
      reasoning: false,
    },
  },
  {
    envId: "env_deepseek_reasoner",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    envVarKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    capabilities: {
      basicStream: true,
      toolCall: true,
      toolChoice: false,
      nativeSchema: false,
      reasoning: true,
    },
  },
];
