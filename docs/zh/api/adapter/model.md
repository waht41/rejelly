# Model Adapter (OpenAI / Gemini)

`createOpenAIAdapter`（`@rejelly/adapter-openai`）与 `createGeminiAdapter`（`@rejelly/adapter-gemini`）负责把 provider 模型包装成 Rejelly 的 `ModelAdapter`，并把 `promptAgent(schema)` 的 JSON Schema 交给底层模型。

多模态工具结果的发送侧契约见 [Adapter · 多模态工具结果](/zh/api/adapter/#多模态工具结果-multimodal-tool-results)。

## 创建模型适配器

### OpenAI

```typescript
import { createOpenAIAdapter } from '@rejelly/adapter-openai';

const model = createOpenAIAdapter({
  modelId: 'gpt-5.6-luna',
  apiKey: process.env.OPENAI_API_KEY,
  schemaMode: 'json_schema',
});
```

`createOpenAIAdapter` 也可接 OpenAI-compatible provider：

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

Gemini 在 Node 环境下若未显式传 `apiKey`，会读取 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`；浏览器环境应显式传入。需要透传 Gemini 请求参数时使用 `generateContentParams`：

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

### 在 Agent 中使用

创建出的对象就是 Rejelly `ModelAdapter`，可直接放进 `createAgent({ model })`，或通过 `runWith` 的模型注册表统一注入。

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

### 费用统计

如果要让 Budget 机制记录真实费用，在 adapter 上提供 `calculateCost`。返回值使用整数单位，例如 `micro_usd`。

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

## Prompt 注入 schema

通过 `schemaMode` 选择 schema 交付方式：

- `"prompt"`：把 schema 注入 system prompt，兼容最广（OpenAI 默认）。
- `"json_object"`：发 `response_format: { type: "json_object" }`（Gemini 为 `responseMimeType: "application/json"`），同时仍注入 schema 到 prompt 补字段约束。适合有 JSON 模式但无严格 schema 的模型（如 DeepSeek）。
- `"json_schema"`：原生 Structured Outputs（OpenAI strict / Gemini `responseSchema`），由模型强约束字段（Gemini 默认）。
