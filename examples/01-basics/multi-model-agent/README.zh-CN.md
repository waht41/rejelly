# Multi-Model Agent (多模态 Agent 示例)

> 中文 | [English](README.md)

这个示例展示了如何在 Rejelly 中处理多模态输入（图片、视频、文本混排）。

在 Rejelly 中，多模态并不是一个特殊的 API，而是通过原生的 `equipInstruction` 机制实现的。你只需要向其传递一个结构化的数组，底层模型适配器会自动将其转换为 LLM 认识的格式。

## 💡 核心机制

**向 `equipInstruction` 传入 `ContentPart[]`**：

当需要混排媒体与文本时，不要传入字符串，而是构造一个包含 `type` 声明的对象数组。

```typescript
import { ContentPart, equipInstruction } from '@rejelly/core';

// 构建多模态内容块
const parts: ContentPart[] = [
  { type: 'text', text: '请分析这张图片和视频中的内容：' },
  { type: 'image', image: { url: 'https://example.com/image.jpg', detail: 'high' } },
  { type: 'video', video: { url: 'https://example.com/video.mp4' } }
];

// 直接装备给 Agent
equipInstruction(parts);
```

## ⚠️ 注意事项

1. **模型支持**：多模态能力强依赖于底层的模型。默认推荐使用 Gemini provider（`EXAMPLE_MODEL_PROVIDER=gemini`，对视频支持极佳），如果使用 OpenAI provider，通常只支持图片 (`gpt-5.6-luna`)。
2. **格式支持**：`image.url` 支持标准的 `http(s)://` 链接，也支持 `data:image/png;base64,...` 格式的数据。

## 📂 目录结构

```text
multi-model-agent/
├── types.ts                  # 输入输出 Schema 定义
├── multi-model-agent.ts      # 核心逻辑：组装 ContentPart 并调用 LLM
├── index.ts                  # 运行入口
└── README.md                 # 文档
```

## 🚀 运行示例

请确保已在 `.env` 中配置了 `GEMINI_API_KEY`（或对应的 OpenAI Key）。

在 `examples` 目录下执行脚本，在交互菜单中选中本示例（**Multi-Model Agent**）即可运行：

```bash
cd examples
pnpm start
```
