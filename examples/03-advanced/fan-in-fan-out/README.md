# Fan-in / Fan-out

> [中文](README.zh-CN.md) | English

This example demonstrates **fan-out** (parallel worker agents) and **fan-in** (single summarizer). The orchestrator spawns multiple worker agents in parallel with `Promise.all`, collects their results, then passes them to a summarizer agent for a final summary.

## Run

From the `examples` root:

```bash
pnpm run start -- --module=fan-in-fan-out --example=default
```

Or pick **Fan-in / Fan-out** under 03-advanced and run the default example.

## Idea

1. **Fan-out**: The orchestrator maps over fixed subtasks (e.g. "causes", "current status", "future outlook") and runs one worker agent per subtask in parallel via `Promise.all`.
2. **Fan-in**: All worker results are collected, then a single summarizer agent receives the full list and produces one overall summary.

```typescript
// Fan-out: run worker agents in parallel
const sectionPromises = SUBTASKS.map((subtask) =>
  WorkerAgent({ topic: props.topic, subtask })
);
const sections = await Promise.all(sectionPromises);

// Fan-in: pass all results to summarizer
const finalSummary = await SummarizerAgent({
  topic: props.topic,
  sections,
});
```

Flow: **Orchestrator → [Worker1, Worker2, Worker3]** (parallel) **→ Summarizer → result**.
