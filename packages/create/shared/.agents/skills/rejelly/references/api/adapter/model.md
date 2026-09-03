# Model Adapter (OpenAI / Gemini)

`createOpenAIAdapter` (`@rejelly/adapter-openai`) and `createGeminiAdapter` (`@rejelly/adapter-gemini`) wrap provider models into Rejelly's `ModelAdapter` and deliver the JSON Schema from `promptAgent(schema)` to the underlying model.

For the send-side contract of multimodal tool results, see [Adapter · Multimodal Tool Results](/en/api/adapter/#multimodal-tool-results).

## Creating a Model Adapter

### OpenAI

```typescript
import { createOpenAIAdapter } from '@rejelly/adapter-openai';

const model = createOpenAIAdapter({
  modelId: 'gpt-5.6-luna',
  apiKey: process.env.OPENAI_API_KEY,
  schemaMode: 'json_schema',
});
```

`createOpenAIAdapter` also works with OpenAI-compatible providers:

```typescript
import { createOpenAIAdapter } from '@rejelly/adapter-openai';

const model = createOpenAIAdapter({
  id: 'deepseek-chat',
  provider: 'deepseek',
  modelId: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
  schemaMode: 'json_object',
  chatCompletionParams: {
    temperature: 0.2,
  },
  requestOption: {
    timeout: 60_000,
  },
});
```

### Gemini

```typescript
import { createGeminiAdapter } from '@rejelly/adapter-gemini';

const model = createGeminiAdapter({
  modelId: 'gemini-2.5-pro',
  apiKey: process.env.GEMINI_API_KEY,
  schemaMode: 'json_schema',
});
```

In Node environments, if `apiKey` is not explicitly passed, Gemini reads `GEMINI_API_KEY` or `GOOGLE_API_KEY`; in browser environments, it should be passed explicitly. Use `generateContentParams` to forward Gemini request parameters:

```typescript
import { createGeminiAdapter } from '@rejelly/adapter-gemini';

const model = createGeminiAdapter({
  modelId: 'gemini-2.5-flash',
  schemaMode: 'prompt',
  generateContentParams: {
    temperature: 0.3,
  },
});
```

### Using in an Agent

The created object is a Rejelly `ModelAdapter` and can be passed directly to `createAgent({ model })`, or injected uniformly via `runWith`'s model registry.

```typescript
import { createAgent, promptAgent } from '@rejelly/core';
import { createOpenAIAdapter } from '@rejelly/adapter-openai';
import { z } from 'zod';

const model = createOpenAIAdapter({
  modelId: 'gpt-5.6-luna',
  apiKey: process.env.OPENAI_API_KEY,
});

const AnswerSchema = z.object({
  answer: z.string(),
});

export const AnswerAgent = createAgent({
  id: 'answer',
  model,
  handler: async () => {
    return await promptAgent(AnswerSchema);
  },
});
```

### Cost Calculation

To have the Budget mechanism record real costs, provide `calculateCost` on the adapter. Return values use integer units, e.g., `micro_usd`.

```typescript
import { createOpenAIAdapter } from '@rejelly/adapter-openai';

const model = createOpenAIAdapter({
  modelId: 'gpt-5.6-luna',
  apiKey: process.env.OPENAI_API_KEY,
  calculateCost: (usage) => ({
    micro_usd:
      Math.ceil(usage.promptTokens * 1) +
      Math.ceil(usage.completionTokens * 6),
  }),
});
```

## Prompt Schema Injection

Choose the schema delivery method via `schemaMode`:

- `"prompt"`：Injects the schema into the system prompt — broadest compatibility (OpenAI default).
- `"json_object"`：Sends `response_format: { type: "json_object" }` (Gemini: `responseMimeType: "application/json"`), while also injecting the schema into the prompt for field constraints. Suitable for models with JSON mode but without strict schema support (e.g., DeepSeek).
- `"json_schema"`：Native Structured Outputs (OpenAI strict / Gemini `responseSchema`), where the model strictly enforces fields (Gemini default).
