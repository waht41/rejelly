# Fan-in / Fan-out 扇入扇出

> 中文 | [English](README.md)

本示例演示 **fan-out（扇出）** 与 **fan-in（扇入）**：编排者用 `Promise.all` 并行启动多个 worker Agent，收集结果后再交给一个 summarizer Agent 做最终汇总。

## 运行

在 `examples` 根目录下：

```bash
pnpm run start -- --module=fan-in-fan-out --example=default
```

或在 03-advanced 下选择 **Fan-in / Fan-out**，运行 default 示例即可。

## 思路

1. **Fan-out**：编排者对固定子任务（如「原因」「现状」「展望」）做 map，用 `Promise.all` 并行调用多个 worker Agent。
2. **Fan-in**：收集所有 worker 的结果后，由一个 summarizer Agent 接收完整列表并输出一段总括。

```typescript
// Fan-out: 并行运行多个 worker
const sectionPromises = SUBTASKS.map((subtask) =>
  WorkerAgent({ topic: props.topic, subtask })
);
const sections = await Promise.all(sectionPromises);

// Fan-in: 将全部结果交给 summarizer
const finalSummary = await SummarizerAgent({
  topic: props.topic,
  sections,
});
```

流程：**Orchestrator → [Worker1, Worker2, Worker3]**（并行）**→ Summarizer → result**。
