/**
 * Adapter choice for create-rejelly: label, package name, and placeholder replacements.
 * No Mock option per requirement.
 */

export const ADAPTER_CHOICES = [
  { title: "OpenAI (GPT)", value: "openai" as const },
  { title: "Gemini (Google)", value: "gemini" as const },
] as const;

export type AdapterChoice = (typeof ADAPTER_CHOICES)[number]["value"];

/** NPM package name for the chosen adapter (for adding to dependencies). */
export function getAdapterPackageName(choice: AdapterChoice): string {
  switch (choice) {
    case "openai":
      return "@rejelly/adapter-openai";
    case "gemini":
      return "@rejelly/adapter-gemini";
    default:
      throw new Error(`Unknown adapter: ${choice}`);
  }
}

export interface AdapterReplacements {
  /** Full line to replace the adapter import line. */
  importLine: string;
  /** Full line for creating the model adapter. */
  modelLine: string;
}

export function getAdapterReplacements(choice: AdapterChoice): AdapterReplacements {
  switch (choice) {
    case "openai":
      return {
        importLine: "import { createOpenAIAdapter } from '@rejelly/adapter-openai';",
        modelLine:
          "const model = createOpenAIAdapter({ modelId: process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna', apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });",
      };
    case "gemini":
      return {
        importLine: "import { createGeminiAdapter } from '@rejelly/adapter-gemini';",
        modelLine:
          "const model = createGeminiAdapter({ modelId: process.env.GEMINI_MODEL_ID || 'gemini-3.0-flash', apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY });",
      };
    default:
      throw new Error(`Unknown adapter: ${choice}`);
  }
}
