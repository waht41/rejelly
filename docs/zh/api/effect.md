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
| `tool_call_stream` | 工具调用参数的流式分片；一次调用会流出多个 chunk，共享同一个 `chunk.index` |
| `tool_call` | 工具调用已组装完成；在 `turn_done` 之前、工具执行之前发出 |
| `usage` | token usage |
| `extra` | 适配器/模型返回的额外元数据 |
| `turn_done` | 本 turn 的最后一个事件，携带适配器的 `finishReason`（缺省时为 `unknown`）；工具尚未开始执行 |
| `error` | 流式过程中出现错误 |

框架在适配器报告 `finish` 时保留 `finishReason`，随后完整消费适配器流，按需发出最终 `structured_data` 快照和每个装配完成的 `tool_call`，最后才发出 `turn_done`。因此可以安全地在这里汇总本轮。完整顺序见 [Core API 的 `onStream`](./core.md#onstream-consumer-options)。

Generation 流没有单独的结束事件：`for await...of` 循环结束就是这个信号。正常关闭、取消以及生产侧失败后（失败会先作为 `error` 事件送达），循环都会正常退出。consumer 自己的代码仍可能抛错，因此必须始终执行的清理要放进 `finally`。

### `structured_data`

`structured_data` 是结构化输出 UI 最常用的事件：

未提供 schema 时，只有累积文本被成功识别为 JSON 对象才会发出该事件；普通文本不会产生无效快照或最终解析错误。

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
