# Testing (测试工具)

Rejelly 提供了mock model，用于在测试环境中模拟 LLM 行为。

## Mock Model

### `createMockModel()`

创建一个可配置的 Mock Model，用于测试 Agent 行为。

**返回值**: `MockModel` 实例

```typescript
import { createMockModel } from '@rejelly/core/testing'
import { createAgent } from '@rejelly/core'

const mock = createMockModel()

// 设置默认响应
mock.setDefaultResponse({ result: 'ok' })

// 创建 Agent
const agent = createAgent({
  id: 'test',
  model: mock.adapter,
  handler: async () => {
    // ... agent logic
  }
})
```

### MockModel API

#### `mock.when(condition)`

定义匹配规则，返回 `RuleBuilder` 用于配置响应行为。

**参数**:
- `condition`: `RuleCondition` - 匹配条件
  - `{ input: string | RegExp }` - 匹配用户消息文本（多条会先 `join(' ')` 再匹配）
  - `{ toolName: string }` - 匹配工具名：最后一条为 tool 且 name 一致、或最后一条 assistant 的 tool_calls 含该名、或任一条用户消息文本包含该字符串
  - `(payload: RulePayload) => boolean` - 自定义匹配函数

**返回值**: `RuleBuilder`

```typescript
// 匹配输入内容
mock.when({ input: 'hello' })
  .thenReturn({ response: 'hi' })

// 使用正则表达式
mock.when({ input: /greet/i })
  .thenReturn({ greeting: 'Hello!' })

// 匹配工具调用
mock.when({ toolName: 'calculator' })
  .thenCallTools([{
    id: 'call_1',
    name: 'calculator',
    arguments: { operation: 'add', a: 1, b: 2 }
  }])

// 自定义匹配函数
mock.when((payload) => {
  return payload.messages.length > 5
}).thenReturn({ result: 'long conversation' })
```

#### RuleBuilder API

##### `thenReturn(response)`

立即返回响应。

```typescript
mock.when({ input: 'hello' })
  .thenReturn({ message: 'hi' })
  .withUsage({ promptTokens: 10, completionTokens: 5 })
```

##### `thenStream(chunksOrObject, chunkSize?)`

流式返回响应。

- **chunksOrObject**: `string[]` 时按顺序逐个 yield 每个字符串；传入对象或其它 JSON 值时会被 `JSON.stringify` 后按字符分块输出。
- **chunkSize**: 仅当 **chunksOrObject** 为对象时有效，表示每块字符数，默认 `1`。

```typescript
mock.when({ input: 'stream' })
  .thenStream([
    'Hello',
    ' ',
    'World',
    '!'
  ])

// 传入对象：会 stringify 后按 chunkSize 分块（默认每块 1 个字符）
mock.when({ input: 'stream' })
  .thenStream({ reply: 'hello world' })

// 指定分块大小
mock.when({ input: 'stream' })
  .thenStream({ reply: 'hello' }, 2)  // 依次 yield "he", "ll", "o"
```

##### `thenCallTools(toolCalls)`

模拟工具调用。

```typescript
mock.when({ toolName: 'search' })
  .thenCallTools([
    {
      id: 'call_1',
      name: 'search',
      arguments: { query: 'test' }
    }
  ])
```

##### `thenThrow(error)`

抛出错误。

```typescript
mock.when({ input: 'error' })
  .thenThrow(new Error('Mock error'))
```

##### `thenDo(fn)`

执行自定义异步函数返回响应。

```typescript
mock.when({ input: 'custom' })
  .thenDo(async (payload) => {
    // payload 包含 messages, schema, userMessages 等
    return { result: `processed ${payload.lastUserMessage}` }
  })
```

##### `withDelay(ms)`

添加响应前的延迟（模拟网络延迟）。

```typescript
mock.when({ input: 'slow' })
  .thenReturn({ result: 'ok' })
  .withDelay(1000) // 延迟 1 秒
```

##### `withChunkInterval(ms)`

设置流式输出中每个 chunk 之间的间隔（模拟真实的流式传输效果）。

```typescript
mock.when({ input: 'stream' })
  .thenStream(['Hello', ' ', 'World', '!'])
  .withChunkInterval(50) // 每个 chunk 间隔 50ms
```

##### `withUsage(usage)`

设置 Token 使用量。

```typescript
mock.when({ input: 'hello' })
  .thenReturn({ result: 'ok' })
  .withUsage({
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150 // 可选，会自动计算
  })
```

#### `mock.setDefaultResponse(response)`

设置默认响应（当没有匹配的规则时使用）。若未设置默认响应且无规则匹配，会抛出错误：`No matching rule found. Use mock.when(...), mock.sequence(...), or mock.setDefaultResponse(...).`

```typescript
mock.setDefaultResponse({ result: 'default' })
```

#### `mock.setDefaultUsage(usage)`

设置默认响应的 Token 使用量。

```typescript
mock.setDefaultUsage({ promptTokens: 10, completionTokens: 5 })
```

#### `mock.setDefaultDelay(ms)`

设置默认响应的延迟（ms）。

```typescript
mock.setDefaultDelay(500) // 默认响应延迟 500ms
```

#### `mock.sequence(steps)`

定义顺序响应，按调用次序依次返回。优先级：Sequence > Rule Match > Default。

```typescript
mock.sequence([
  { type: 'json', content: { step: 'first' } },
  { type: 'json', content: { step: 'second' } },
  { type: 'json', content: { step: 'third' } },
])
```

#### `mock.setSequenceUsage(usage)`

设置顺序响应的 Token 使用量。

```typescript
mock.setSequenceUsage([
  { promptTokens: 10, completionTokens: 5 },
  { promptTokens: 20, completionTokens: 10 },
])
```

#### `mock.setSequenceDelay(ms)`

设置顺序响应的延迟（ms）。

```typescript
mock.setSequenceDelay(200) // 每次 sequence 响应延迟 200ms
```

#### `mock.setCostCalculator(calculator)`

自定义计费函数，覆盖默认的 token 计费逻辑。

```typescript
mock.setCostCalculator((usage) => {
  return {
    usd: usage.promptTokens * 0.00003 + usage.completionTokens * 0.00006,
  }
})
```

#### `mock.calls`

调用记录 API，用于检查 Agent 对 LLM 的调用。

```typescript
// 获取所有调用记录
const allCalls = mock.calls.all()

// 获取调用次数
const count = mock.calls.count()

// 获取第一次调用
const firstCall = mock.calls.first()

// 获取最后一次调用
const lastCall = mock.calls.last()

// 清空调用记录
mock.calls.clear()
```

**CallRecord 结构**:
```typescript
interface CallRecord {
  messages: Message[]      // 发送给模型的消息
  schema?: JsonSchema      // JSON Schema（如果有）
  timestamp: number        // 时间戳
  index: number           // 调用索引（从 0 开始）
}
```

#### `mock.reset()`

重置所有规则和调用记录。

```typescript
mock.reset()
```

#### `mock.adapter`

ModelAdapter 实例，用于传递给 `createAgent`。

```typescript
const agent = createAgent({
  id: 'test',
  model: mock.adapter,
  handler: async () => { /* ... */ }
})
```

## 完整示例

```typescript
import { createMockModel } from '@rejelly/core/testing'
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core'
import { z } from 'zod'

// 创建 Mock Model
const mock = createMockModel()

// 配置响应规则
mock.when({ input: 'hello' })
  .thenReturn({ answer: 'Hello, World!' })
  .withUsage({ promptTokens: 10, completionTokens: 5 })

mock.when({ input: 'calculate' })
  .thenCallTools([
    {
      id: 'call_1',
      name: 'calculator',
      arguments: { operation: 'add', a: 1, b: 2 }
    }
  ])

// 设置默认响应
mock.setDefaultResponse({ result: 'default response' })

// 创建测试 Agent
const TestAgent = createAgent({
  id: 'test_agent',
  model: mock.adapter,
  handler: async (props: { query: string }) => {
    equipSystem('你是一个助手')
    equipInstruction(`用户查询：${props.query}`)
    
    const ResultSchema = z.object({
      answer: z.string()
    })
    
    return await promptAgent(ResultSchema)
  }
})

// 运行测试
const result = await TestAgent({ query: 'hello' })
console.log(result) // { answer: 'Hello, World!' }

// 检查调用记录
const lastCall = mock.calls.last()
console.log(lastCall?.messages) // 查看发送给模型的消息
console.log(mock.calls.count()) // 调用次数
```

## 类型定义

```typescript
interface MockModel {
  when(condition: RuleCondition): RuleBuilder
  calls: CallsAPI
  adapter: ModelAdapter
  reset(): void
  setDefaultResponse(response: MockResponse): void
  setDefaultUsage(usage: MockUsage): void
  setDefaultDelay(ms: number): void
  sequence(steps: MockSequenceStep[]): void
  setSequenceUsage(usage: MockUsage[]): void
  setSequenceDelay(ms: number): void
  setCostCalculator(calculator: (usage: TokenUsage) => Record<string, number>): void
}

interface RuleBuilder {
  thenReturn(response: MockResponse): RuleBuilder
  /** chunksOrObject: string[] 或 JsonValue；chunkSize 仅对象时有效，分块字符数，默认 1 */
  thenStream(chunksOrObject: StreamInput, chunkSize?: number): RuleBuilder
  thenCallTools(toolCalls: MockToolCall[]): RuleBuilder
  thenThrow(error: Error): RuleBuilder
  thenDo(fn: (payload: RulePayload) => Promise<MockResponse>): RuleBuilder
  withDelay(ms: number): RuleBuilder
  withChunkInterval(ms: number): RuleBuilder
  withUsage(usage: MockUsage): RuleBuilder
  withExtra(extra: Record<string, unknown>): RuleBuilder
}

type RuleCondition =
  | { input: string | RegExp }
  | { toolName: string }
  | ((payload: RulePayload) => boolean)

interface RulePayload {
  messages: Message[]
  schema?: JsonSchema
  /** 最后一条用户消息的文本（多模态时 image/video 会变成 "[image]"/"[video]"） */
  lastUserMessage?: string
  /** 所有用户消息的文本拼接来源（同上，仅文本部分） */
  userMessages: string[]
}

interface CallsAPI {
  all(): CallRecord[]
  count(): number
  first(): CallRecord | undefined
  last(): CallRecord | undefined
  clear(): void
}

interface CallRecord {
  messages: Message[]
  schema?: JsonSchema
  timestamp: number
  index: number
}

/** 字符串或可 JSON 序列化的值（对象、数组、基本类型） */
type MockResponse = string | JsonValue

/** 流式输入：字符串数组（按序 yield），或对象/值（stringify 后按 chunkSize 分块） */
type StreamInput = string[] | JsonValue

type MockSequenceStep =
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'text'
      content: string
    })
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'json'
      content: JsonValue
    })
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'stream'
      chunks: string[]
    })
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'stream_object'
      content: JsonValue
      chunkSize?: number
    })
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'tool_calls'
      calls: MockToolCall[]
    })
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'error'
      error: Error
    })
  | ({ delay?: number; chunkInterval?: number; extra?: Record<string, unknown>; usage?: MockUsage } & {
      type: 'custom'
      handler: (payload: RulePayload) => Promise<MockResponse>
    })

interface MockUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Extra token dimensions forwarded to TokenUsage.details (e.g. reasoningTokens, cacheReadTokens) */
  details?: Record<string, number>
}

interface MockToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** Tool-call-level metadata forwarded to StreamEvent.tool_call.toolCall.extra */
  extra?: Record<string, unknown>
}
```
