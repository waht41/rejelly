# Effect (副作用)

只负责过程展示，不介入控制流。

## `onStream(consumer, options?)`

监听当前 Generation 内的 Agent 级流事件，用于实时展示模型输出、结构化数据解析进度、工具调用过程、token usage 等。

在同一 Generation 内必须在 `promptAgent()` / `promptChat()` **之前**注册；若在之后再调用 `onStream()`，会抛出 `AfterPromptAgentError`（由 `@rejelly/core` 导出）。

```typescript
onStream(
  async (stream) => {
    for await (const event of stream) {
      if (event.type === 'structured_data') {
        // event.status: 'partial' | 'complete' | 'error'
        // event.data: 当前可解析出的结构化数据
        // event.isValid: 当前数据是否通过轻量 schema 检查
        updateUI(event.data);
      }

      if (event.type === 'text') {
        // 原始正文增量；用于打字机效果或兜底显示
        appendRawText(event.delta);
      }

      if (event.type === 'tool_call') {
        showToolCall(event.toolCall);
      }
    }
  },
  { awaitOnEnd: true },
);

const result = await promptAgent(ResponseSchema);
```

### 常用事件

| 事件 | 说明 |
|------|------|
| `turn_start` | 一个 LLM turn 开始 |
| `text` | 模型正文增量，字段为 `delta` |
| `reasoning` | 推理/思考增量，字段为 `delta` |
| `structured_data` | 当前文本缓冲解析出的结构化数据 |
| `tool_call_stream` | 工具调用参数的流式分片 |
| `tool_call` | 工具调用已组装完成 |
| `usage` | token usage |
| `extra` | 适配器/模型返回的额外元数据 |
| `turn_done` | 一个 LLM turn 结束 |
| `error` | 流式过程中出现错误 |

### `structured_data`

`structured_data` 是结构化输出 UI 最常用的事件：

```typescript
onStream(
  async (stream) => {
    for await (const event of stream) {
      if (event.type !== 'structured_data') continue;

      if (event.status === 'partial' && event.isValid) {
        renderPartial(event.data);
      }

      if (event.status === 'complete') {
        renderFinal(event.data);
      }

      if (event.status === 'error') {
        showFallback();
      }
    }
  },
  { awaitOnEnd: true },
);
```

- `status: 'partial'`：流还在继续，`data` 是当前能解析出的部分结构。
- `status: 'complete'`：本 turn 结束且解析成功。
- `status: 'error'`：本 turn 结束但结构化解析失败。
- `isValid`：当前 `data` 是否通过轻量 schema 检查；它不是完整 Zod 校验。

`options.awaitOnEnd` 默认为 `true`，当前 generation 结束前会等待 stream consumer 消费完事件并完成自身收尾（例如测试、写日志、同步 UI 状态）。纯 UI fire-and-forget consumer 可显式设为 `false`。
