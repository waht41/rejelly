# Multi-Model Agent (Multimodal Agent Example)

> [中文](README.zh-CN.md) | English

This example shows how to handle **multimodal input** (image, video, and text) in Rejelly.

In Rejelly, multimodality is not a special API but is implemented via the built-in `equipInstruction` mechanism. You pass a structured array; the underlying model adapter converts it into the format the LLM expects.

## Core mechanism

**Pass `ContentPart[]` to `equipInstruction`**:

When mixing media and text, pass an array of objects with a `type` field instead of a plain string.

```typescript
import { ContentPart, equipInstruction } from '@rejelly/core';

// Build multimodal content parts
const parts: ContentPart[] = [
  { type: 'text', text: 'Please analyze the content in this image and video:' },
  { type: 'image', image: { url: 'https://example.com/image.jpg', detail: 'high' } },
  { type: 'video', video: { url: 'https://example.com/video.mp4' } }
];

// Equip the Agent directly
equipInstruction(parts);
```

## Notes

1. **Model support**: Multimodal capability depends on the underlying model. The Gemini provider (`EXAMPLE_MODEL_PROVIDER=gemini`) is recommended by default (strong video support). With the OpenAI provider, typically only images are supported (`gpt-5.6-luna`).
2. **Format support**: `image.url` supports standard `http(s)://` URLs and `data:image/png;base64,...` data URIs.

## Directory structure

```text
multi-model-agent/
├── types.ts                  # Input/output schema definitions
├── multi-model-agent.ts      # Core logic: build ContentPart and call LLM
├── index.ts                  # Entry point
└── README.md                 # Documentation
```

## Run the example

Ensure `GEMINI_API_KEY` (or the corresponding OpenAI key) is set in `.env`.

From the `examples` directory, run the script and select this example (**Multi-Model Agent**) in the interactive menu:

```bash
cd examples
pnpm start
```
