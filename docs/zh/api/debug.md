# Debug (调试与可观测性)

Debugger 模块提供了日志记录和可观测性工具，帮助开发者调试和监控 Agent 的执行过程。

## 模块概览

Debugger 模块包含两类调试与可观测性接入：

1. **OTLP Exporter**：将追踪事件发送到 OTLP 兼容服务器（如 Jaeger、Zipkin、Tempo）
2. **Review Exporter**：将追踪事件实时发送到 Rejelly Review Server，用于可视化调试

这些能力都基于框架的 EventBus 机制，通过订阅事件来记录或导出 Agent 的执行轨迹。

`withCustomSpan` 是主动埋点 API：在 Agent 执行过程中手动创建子 span，并产出 `custom:span:start` / `custom:span:end` 事件，供 OTLP Exporter 与 Review Exporter 统一消费。

## Custom Span

### `withCustomSpan(name, fn, options?)`

手动创建追踪 span，用于标记业务步骤、外部调用、批处理阶段等框架无法自动识别的执行片段。它必须在 Agent 运行上下文内调用；没有当前 AgentContext 时会抛出 `RequiresAgentContextError`。

- `name`: span 名称
- `fn`: 在该 span 下执行的异步函数，接收 `span` 参数
- `options.attributes`: span 开始时写入的静态属性
- `span.setAttribute(key, value)`: 运行中追加单个属性
- `span.setAttributes(attributes)`: 运行中追加多个属性

```typescript
import { withCustomSpan } from '@rejelly/core';

const result = await withCustomSpan('fetch-user-data', async (span) => {
  span.setAttribute('user_id', userId);

  const data = await fetchUserData(userId);

  span.setAttribute('data_size', data.length);
  return data;
});

await withCustomSpan(
  'process-batch',
  async (span) => {
    span.setAttributes({ batch_size: items.length });
    const count = await processItems(items);
    span.setAttribute('processed', count);
  },
  { attributes: { operation: 'batch-process' } },
);
```

## OTLP Exporter

OTLP 导出器，将追踪事件发送到 OTLP 兼容服务器（如 Jaeger、Zipkin、Tempo、Grafana Cloud 等）。使用 HTTP/JSON 格式，无需 protobuf 依赖。

**基本用法：**

```typescript
import { enableOTLP } from '@rejelly/core/debugger';

// 启用 OTLP traces 导出
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-app',
});

await MyAgent({ topic: 'test' });

// 禁用并刷新剩余事件
await disable();
```

**配置选项：**

```typescript
interface OTLPOptions {
  /** OTLP 端点 URL（例如: 'http://localhost:4318/v1/traces'） */
  endpoint: string;
  /** 自定义事件总线（可选，默认使用全局总线） */
  eventBus?: EventBus;
  /** 服务名称（默认: 'rejelly'） */
  serviceName?: string;
  /** 额外的资源属性 */
  resourceAttributes?: Record<string, string>;
  /** HTTP 请求的自定义请求头 */
  headers?: Record<string, string>;
  /** 按事件过滤（可选） */
  filter?: (event: TraceEvent) => boolean;
  /** 在导出边界转换事件；发生在 filter 之后、OTLP 转换之前 */
  convert?: TraceEventConverter;
  /** 批量发送前的批次大小（默认: 10） */
  batchSize?: number;
  /** 刷新间隔（毫秒）（默认: 5000） */
  flushInterval?: number;
  /** 最大内存队列长度，超过后丢弃新事件（默认: 5000） */
  maxQueueSize?: number;
  /** HTTP 可重试失败的最大重试次数（默认: 3） */
  maxRetries?: number;
  /** 生命周期钩子，见下方「进程退出处理」 */
  registerShutdown?: ExporterRegisterShutdown | false;
}
```

**示例：**

```typescript
// 基本配置
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-app',
});

// 完整配置
const disable = enableOTLP({
  endpoint: 'https://api.grafana.cloud/otlp/v1/traces',
  serviceName: 'production-agent',
  resourceAttributes: {
    'environment': 'production',
    'version': '1.0.0',
  },
  headers: {
    'Authorization': 'Basic ' + Buffer.from('user:pass').toString('base64'),
  },
  batchSize: 20,
  flushInterval: 10000,
});

// 使用自定义事件总线
const customEventBus = createEventBus();
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  eventBus: customEventBus,
});

// 在导出前脱敏或整理事件
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  convert: (event) => ({
    ...event,
    props: event.props ? redactSecrets(event.props) : event.props,
  }),
});
```

**事件转换规则：**

- **Span 事件**：默认忽略 `:start` 事件；带生命周期的 `:end` 事件会转换为 OTLP Span
- **即时事件**：没有 `duration` 字段的 trace-local 事件会折叠为父 Span 上的 OTLP Span Event，不会导出零持续时间 Span
- **错误处理**：错误信息会被转换为 OTLP 异常事件，包含 `exception.type`、`exception.message` 和 `exception.stacktrace`
**批量发送机制：**

- 事件会被缓存在内存中
- 当缓存数量达到 `batchSize` 时，自动发送批次
- 每隔 `flushInterval` 毫秒自动刷新一次
- 同一时间只允许一个发送任务执行；重试期间不会并发发起新的 HTTP 请求
- 当队列长度达到 `maxQueueSize` 时会丢弃最旧事件，优先保留最新观测数据
- 调用 `disable()` 时会刷新所有剩余事件

**进程退出处理：**

- 默认通过 `registerNodeShutdown()` 监听 `SIGINT`、`SIGTERM` 和 `beforeExit`
- 退出前会尝试刷新剩余事件；刷新阶段的强制退出超时由 `registerNodeShutdown` 的 `shutdownTimeout` 控制（默认 3000ms），需要自定义可传 `registerShutdown: registerNodeShutdown({ shutdownTimeout: 5000 })`
- 若需要在 `uncaughtException` / `unhandledRejection` 时刷新，可传入 `registerShutdown: registerNodeShutdown({ catchGlobalErrors: true })`（可能与 Sentry 等冲突）

**支持的 OTLP 服务器：**

- Jaeger
- Zipkin
- Tempo
- Grafana Cloud
- 任何兼容 OTLP HTTP/JSON 格式的服务器

**注意事项：**

- 只将带生命周期的 `:end` 事件导出为 Span；即时事件会作为 Span Event 附着到目标 Span，忽略 `:start` 事件
- 使用 HTTP/JSON 格式，无需 protobuf 依赖
- Trace ID 和 Span ID 会自动转换为 32 位和 16 位十六进制字符串
- 如果父 Span ID 不存在，会省略 `parentSpanId` 字段（某些服务器要求）

## Review Exporter

Review 导出器，将追踪事件实时发送到 Rejelly Review Server。支持 `:start` 和 `:end` 事件，用于实时可视化追踪。使用原始事件格式（不进行 OTLP 转换）。

**基本用法：**

```typescript
import { enableReview } from '@rejelly/core/debugger';

// 启用 Review 导出
const disable = enableReview({
  endpoint: 'http://localhost:5789/api/v1/traces',
});

await MyAgent({ topic: 'test' });

// 禁用并刷新剩余事件
await disable();
```

**配置选项：**

```typescript
import type { TraceEvent } from '@rejelly/core';

interface ReviewOptions {
  /** Review 服务器端点 URL（默认: REJELLY_REVIEW_ENDPOINT 或 'http://localhost:5789/api/v1/traces'） */
  endpoint?: string;
  /** 自定义事件总线（可选，默认使用全局总线） */
  eventBus?: EventBus;
  /** 自定义 HTTP 请求头（例如通过 `Authorization` 传入 API Key） */
  headers?: Record<string, string>;
  /** 按事件过滤（可选） */
  filter?: (event: TraceEvent) => boolean;
  /** 批量发送前的批次大小（默认: 10） */
  batchSize?: number;
  /** 刷新间隔（毫秒）（默认: 5000） */
  flushInterval?: number;
  /** 最大内存队列长度，超过后丢弃新事件（默认: 5000） */
  maxQueueSize?: number;
  /** HTTP 可重试失败的最大重试次数（默认: 3） */
  maxRetries?: number;
  /** 生命周期钩子，见下方「进程退出处理」 */
  registerShutdown?: ExporterRegisterShutdown | false;
}
```

**示例：**

```typescript
// 基本配置
const disable = enableReview({
  endpoint: 'http://localhost:5789/api/v1/traces',
});


// 使用自定义事件总线
const customEventBus = createEventBus();
const disable = enableReview({
  endpoint: 'http://localhost:5789/api/v1/traces',
  eventBus: customEventBus,
});

// Filter events (predicate)
const disable = enableReview({
  endpoint: 'http://localhost:5789/api/v1/traces',
  filter: (event) =>
    ['agent:start', 'agent:end', 'turn:start', 'turn:end'].includes(event.type),
});
```

**实时模式特性：**

- **支持 Start 事件**：与 OTLP Exporter 不同，Review Exporter 支持 `:start` 事件，实现真正的实时追踪
- **原始事件格式**：直接发送原始事件格式，不进行 OTLP 转换
- **实时可视化**：默认批次大小为 10，刷新间隔为 5 秒；可通过 `batchSize` 和 `flushInterval` 调低延迟

**批量发送机制：**

- 事件会被缓存在内存中
- 当缓存数量达到 `batchSize` 时，自动发送批次
- 每隔 `flushInterval` 毫秒自动刷新一次
- 同一时间只允许一个发送任务执行；重试期间不会并发发起新的 HTTP 请求
- 当队列长度达到 `maxQueueSize` 时会丢弃最旧事件，优先保留最新观测数据
- 调用 `disable()` 时会刷新所有剩余事件

**进程退出处理：**

- 默认通过 `registerNodeShutdown()` 监听 `SIGINT`、`SIGTERM` 和 `beforeExit`
- 退出前会尝试刷新剩余事件；刷新阶段的强制退出超时由 `registerNodeShutdown` 的 `shutdownTimeout` 控制（默认 3000ms），需要自定义可传 `registerShutdown: registerNodeShutdown({ shutdownTimeout: 5000 })`
- 若需要在 `uncaughtException` / `unhandledRejection` 时刷新，可传入 `registerShutdown: registerNodeShutdown({ catchGlobalErrors: true })`（可能与 Sentry 等冲突）

**注意事项：**

- 支持 `:start` 和 `:end` 事件，用于实时可视化
- 使用原始事件格式，不进行 OTLP 转换
- 可通过 `batchSize` 和 `flushInterval` 调整实时性与请求频率
- 错误会输出到控制台，不会抛出异常（避免影响主流程）
