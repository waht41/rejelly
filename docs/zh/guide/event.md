# 事件系统

Rejelly 的事件系统提供了完整的可观测性能力，让开发者能够实时监控 Agent 的执行过程、调试问题、收集指标，以及构建可视化工具。

## 概述

事件系统采用发布-订阅（Pub/Sub）模式，框架在执行过程中会自动发出各种类型的事件，开发者可以通过订阅这些事件来监听 Agent 的执行状态。

### 核心特性

- **自动发出**：框架在执行过程中自动发出事件，无需手动触发
- **类型安全**：所有事件都有明确的类型定义，支持 TypeScript 类型检查
- **追踪上下文**：每个事件都包含完整的追踪上下文（traceId、spanId、parentSpanId），支持分布式追踪
- **非侵入性**：事件系统不影响 Agent 的执行逻辑，完全解耦
- **灵活订阅**：支持订阅特定事件类型或所有事件（使用 `'*'` 通配符）

## 事件类型速查

事件覆盖 Agent 执行的各个阶段。下表按分类给出**何时发出**与**关键 payload**；每个 payload 的完整字段以类型定义为准（见 [字段权威来源](#字段权威来源)），此处只点到最常用的几个，避免与类型漂移。多数分类是成对的 Span 事件（`:start` / `:end`），`:end` 通用带 `duration`、`success`、失败时的 `error`（`ErrorInfo`），下表不再逐条重复。

| 分类 | 事件 | 何时发出 | 关键 payload（除通用字段外） |
|------|------|----------|------------------------------|
| RunWith | `runWith:start` / `:end` | 最外层执行入口开/合，**所有其他事件都在其间** | start: `props`、是否带快照 / eventBus、注册的 model / provider key |
| Agent 生命周期 | `agent:start` / `:end` | Agent 完整执行周期开/合 | start: `props`、`middlewares`；end: `result`、`generationCount` |
| | `agent:reborn` | Agent 触发重生 | `generationId`（从 0）、`newProps`（若变更） |
| Generation | `generation:start` / `:end` | 每一代（首次或 reborn 后）开/合 | start: `generationId`（0-based）、`props`（此时 draft 空、memory 未变）；end: 供 DevTool 的组装 `draft` 视图、本代 `memory`、`endReason`（`'return'` \| `'error'` \| `'reborn'`） |
| PromptAgent | `promptAgent:start` / `:end` | `promptAgent()` 调用前 / 所有 tool loop 后 | start: `generationId`、`schema`、`policyId`；end: `totalSteps`、`cache` |
| Turn | `turn:start` / `:end` | 单个 step 开/合 | start: `step`（0-based）、`messages`、`schema`、`toolConfig`、`messageCount`；end: `resultType`（`'content'` \| `'tool_calls'`）、`message`、`contentHash`、`cache` |
| Validation | `validation:success` / `:fail` | 输出校验通过 / 失败（归属 `promptAgent` 作用域） | 共有 `rawText`、`attempt`；success: `data`；fail: 部分 `data`、`errors`（`ErrorInfo[]`） |
| 模型调用 | `model:call:start` / `:end` | 模型适配器**物理请求**开/合 | start: `adapterId`、`provider`、`messageCount`、`usedTools`、`middlewares`、`networkAttempt`；end: `rawText` / `reasoning` / `toolCalls`、`ttft`、`usage`（推理模型可含 `details.reasoningTokens`）、`costs`、`finishReason` |
| Budget | `budget:update` | `updateBudgetChain` 记录 LLM / 工具用量时 | `identifiers`、`delta`、`aggregate` |
| Instrument | `instrument:op:start` / `:end` | `instrument()` 包装的依赖方法（Redis / DB / SDK / 向量库…）调用开/合 | `name`（分类）、`operation`（方法名）；脱敏 metadata 进 `trace.attributes` |
| Resource | `resource:op:start` / `:end` | `equipResource` 创建 / 销毁开/合 | `operation`（`'create'` \| `'destroy'`）、`resourceId`；end: `reused`（创建时复用现有实例） |
| 工具执行 | `tools:execute:start` / `:end` | 一批 `tool_calls` 执行开/合 | start: `toolCallsCount`、`toolNames`、`toolMiddlewares`；end: `successCount`、`failureCount`、`toolResults[]`（`callId` / `toolName` / `input` / `output` / `duration` / `success` / `error` / `cache` / `contentHash`） |
| 自定义跨度 | `custom:span:start` / `:end` | 手动 span 开/合 | `name`；属性统一在 `trace.attributes`（start 为静态子集、end 为合并全集） |
| 错误 | `error` | 发生错误 | `ErrorInfo`：`name`、`message`、`stack?`、`cause?`（错误链）、`details?`（自定义错误类字段） |
| 系统日志 | `sys:log` | 内部 Logger 桥接，**仅在有活跃追踪上下文时**发出（否则降级 `console.warn`） | `level`（`debug` \| `info` \| `warning` \| `error`）、`message`、`args`；保证带 `trace` 上下文 |

> **限流不发事件**：限流由 [`@rejelly/limit-model`](/zh/api/limit-model) 的 `withLimit` / `withSimpleLimit` 实现，采用快速失败策略直接抛错，不发「限流等待」类事件。

### 字段权威来源

上表刻意不穷举字段——payload 结构会演进，散文清单最易腐坏。要看某个事件的**完整、当前**字段，直接读类型定义：

- 事件类型常量：`EVENTS`（`@rejelly/core` 导出）
- Payload 类型：`packages/core/src/core/domain/event-payload.ts` 与 `events.ts`

## 事件结构

所有事件都继承自基础事件结构（`BaseTraceEvent`），包含以下通用字段：

- **`type`**：事件类型（如 `'agent:start'`），对应常量见 `EVENTS`
- **`trace`**：追踪上下文（`TraceContext`），包含 `traceId`、`spanId`、`parentSpanId` 等
- **`timestamp`**：事件时间戳（毫秒）
- **`agentId`**：Agent ID（可选）

需要生成作用域的事件会在事件体上声明 `generationId`。不同类型的事件还包含各自字段：Start 类通常带输入参数，End 类通常带结果、耗时（`duration`）、是否成功（`success`）及失败时的 `ErrorInfo`。

**错误信息（ErrorInfo）**：End 事件和错误相关事件统一使用可序列化的 `ErrorInfo`，包含 `name`、`message`、可选 `stack`、可选 `cause`（错误链）、可选 `details`（自定义错误类的结构化字段，供 DevTool 等使用）。可由 `Error` 对象或直接构造。

## 执行层次和上下文隔离

事件系统反映了代码的执行层次结构：

### 执行层次

1. **`runWith`**：最外层执行入口，总是在执行栈的最顶层。所有其他事件都在 `runWith:start` 和 `runWith:end` 之间发出。

2. **Agent 和 Generation**：在 runWith 内部执行，代表 Agent 的完整执行周期。

3. **其他事件**：如 PromptAgent、Turn、Model Call、Validation 等，都在 Agent 执行过程中发出。

### 上下文隔离

Agent 会创建自己的子上下文，用于隔离 memory、资源和追踪范围。子 Agent 可以通过 scope/resource 显式读取上游暴露的数据。

## 使用方式

事件发布与订阅由 **`EventBus`** 提供（实现见 `packages/core/src/core/observability/event-bus.ts`）。框架不再导出顶层的 `subscribe` / `subscribeOnce` / `subscribeMany` 等语法糖，请在总线实例上调用 `subscribe`、`subscribeOnce`、`subscribeMany`。

### 订阅事件

通过 `getGlobalEventBus()` 取得默认总线后订阅，可订阅某一类型或通配符 `'*'`：

```typescript
import { getGlobalEventBus, EVENTS } from '@rejelly/core';

const bus = getGlobalEventBus();

const offStart = bus.subscribe(EVENTS.AGENT_START, (event) => {
  console.log('Agent started:', event.agentId);
});

const offAll = bus.subscribe('*', (event) => {
  console.log('Event:', event.type, event.timestamp);
});

offStart();
offAll();
```

### 一次性订阅

使用 `subscribeOnce` 只监听一次，触发后自动取消：

```typescript
import { getGlobalEventBus, EVENTS } from '@rejelly/core';

const bus = getGlobalEventBus();

bus.subscribeOnce(EVENTS.AGENT_END, (event) => {
  console.log('Agent completed:', event.success);
});
```

### 订阅多个事件类型

使用 `subscribeMany` 一次注册多个事件类型：

```typescript
import { getGlobalEventBus, EVENTS } from '@rejelly/core';

const bus = getGlobalEventBus();

const unsubscribe = bus.subscribeMany(
  [EVENTS.AGENT_START, EVENTS.AGENT_END],
  (event) => {
    console.log('Agent lifecycle event:', event.type);
  },
);

unsubscribe();
```

### 自定义事件总线

默认执行路径会往全局总线上发事件。若需要隔离（例如独立沙箱、单独采集某次 `runWith`），可 `createEventBus()` 得到独立实例，API 与全局总线相同；再通过 `runWith(..., { eventBus })` 等选项注入，使该次运行只往该总线上发事件：

```typescript
import { createEventBus, runWith } from '@rejelly/core';

const customEventBus = createEventBus();

customEventBus.subscribe('*', (event) => {
  console.log('Custom event:', event.type);
});

await runWith(async () => {
  return await MyAgent({ input: 'test' });
}, { eventBus: customEventBus });
```

## 应用场景

### 日志记录

事件系统最常见的用途是记录执行日志。框架提供了内置的可观测性导出器：

- **Review Exporter**：使用 `enableReview()` 将追踪事件实时发送到 Rejelly Review Server 可视化调试
- **OTLP Exporter**：使用 `enableOTLP()` 将追踪事件发送到 OTLP 兼容服务器（Jaeger、Zipkin、Tempo 等）

### 性能监控

通过监听模型调用事件和工具执行事件，可以收集性能指标：

- 监控每次 LLM 调用的耗时
- 统计 Token 使用量和成本
- 跟踪工具执行时间

### 调试和可视化

事件系统为调试工具提供了数据基础：

- **开发工具**：Rejelly DevTool 通过 WebSocket 接收事件，实时展示执行过程
- **分布式追踪**：通过 OTLP 导出器，可以将事件转换为标准的追踪数据
- **时间旅行调试**：通过 `restoreSnapshot()` 可以从事件追踪恢复执行状态

### 自定义监控

开发者可以基于事件系统构建自定义的监控方案：

- 实时告警：监听错误事件，触发告警通知
- 成本统计：汇总模型调用事件，计算总成本
- 执行分析：分析事件序列，识别性能瓶颈
- 审计日志：记录所有关键操作，满足合规要求

## 与快照系统的关系

事件系统和快照系统紧密配合：

- **事件追踪**：事件序列记录了完整的执行历史
- **快照恢复**：通过 `restoreSnapshot()` 可以从事件追踪恢复快照，实现时间旅行
- **重放机制**：恢复的快照可以重放历史执行，用于测试和调试

## 最佳实践

1. **按需订阅**：只订阅需要的事件类型，避免处理不必要的事件
2. **及时取消**：在组件卸载或任务完成时，记得取消订阅，避免内存泄漏
3. **错误处理**：事件回调中的错误不会影响 Agent 执行，但应该妥善处理
4. **性能考虑**：事件回调应该尽量轻量，避免阻塞事件总线
5. **类型安全**：使用 TypeScript 类型检查，确保事件处理的类型安全

## 总结

事件系统是 Rejelly 可观测性的核心，它提供了：

- **完整的执行追踪**：覆盖 Agent 执行的各个阶段
- **灵活的订阅机制**：支持多种订阅方式
- **丰富的应用场景**：日志、监控、调试、可视化等
- **与快照系统的集成**：支持时间旅行和状态恢复

通过事件系统，开发者可以深入了解 Agent 的执行过程，快速定位问题，优化性能，并构建强大的调试和监控工具。
