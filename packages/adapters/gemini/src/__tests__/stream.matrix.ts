import type { TestCapabilities } from "@rejelly/test-utils";

export interface GeminiStreamTestMatrixItem {
  envId: string;
  provider: "gemini";
  modelId: string;
  envVarKey: string;
  capabilities: TestCapabilities;
}

export const streamTestMatrix: GeminiStreamTestMatrixItem[] = [
  {
    envId: "env_gemini_flash",
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
    envVarKey: "GEMINI_API_KEY",
    capabilities: {
      basicStream: true,
      toolCall: true,
      toolChoice: true,
      nativeSchema: true,
      reasoning: true,
    },
  },
];
