# Testing

Rejelly provides a mock model for simulating LLM behavior in test environments.

## Mock Model

### `createMockModel()`

Creates a configurable Mock Model for testing Agent behavior.

**Returns**: `MockModel` instance

```typescript
import { createMockModel } from '@rejelly/core/testing'
import { createAgent } from '@rejelly/core'

const mock = createMockModel()

// Set default response
mock.setDefaultResponse({ result: 'ok' })

// Create Agent
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

Defines a matching rule, returns a `RuleBuilder` for configuring the response behavior.

**Parameters**:
- `condition`: `RuleCondition` - Matching condition
  - `{ input: string | RegExp }` - Match user message text (multiple messages are `join(' ')` first, then matched)
  - `{ toolName: string }` - Match a tool name: last message is a tool with matching name, or last assistant's tool_calls contains that name, or any user message text contains that string
  - `(payload: RulePayload) => boolean` - Custom matching function

**Returns**: `RuleBuilder`

```typescript
// Match input content
mock.when({ input: 'hello' })
  .thenReturn({ response: 'hi' })

// Use regular expression
mock.when({ input: /greet/i })
  .thenReturn({ greeting: 'Hello!' })

// Match tool call
mock.when({ toolName: 'calculator' })
  .thenCallTools([{
    id: 'call_1',
    name: 'calculator',
    arguments: { operation: 'add', a: 1, b: 2 }
  }])

// Custom matching function
mock.when((payload) => {
  return payload.messages.length > 5
}).thenReturn({ result: 'long conversation' })
```

#### RuleBuilder API

##### `thenReturn(response)`

Immediately returns a response.

```typescript
mock.when({ input: 'hello' })
  .thenReturn({ message: 'hi' })
  .withUsage({ promptTokens: 10, completionTokens: 5 })
```

##### `thenStream(chunksOrObject, chunkSize?)`

Returns a response via streaming.

- **chunksOrObject**: When `string[]`, yields each string in order sequentially. When an object or other JSON value, it's `JSON.stringify`'d and split into character-sized chunks.
- **chunkSize**: Only effective when **chunksOrObject** is an object. Number of characters per chunk, default `1`.

```typescript
mock.when({ input: 'stream' })
  .thenStream([
    'Hello',
    ' ',
    'World',
    '!'
  ])

// Pass an object: stringified then chunked by chunkSize (default 1 character per chunk)
mock.when({ input: 'stream' })
  .thenStream({ reply: 'hello world' })

// Specify chunk size
mock.when({ input: 'stream' })
  .thenStream({ reply: 'hello' }, 2)  // yields "he", "ll", "o" in order
```

##### `thenCallTools(toolCalls)`

Simulates tool calls.

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

Throws an error.

```typescript
mock.when({ input: 'error' })
  .thenThrow(new Error('Mock error'))
```

##### `thenDo(fn)`

Executes a custom async function to return a response.

```typescript
mock.when({ input: 'custom' })
  .thenDo(async (payload) => {
    // payload contains messages, schema, userMessages, etc.
    return { result: `processed ${payload.lastUserMessage}` }
  })
```

##### `withDelay(ms)`

Adds a delay before the response (simulates network latency).

```typescript
mock.when({ input: 'slow' })
  .thenReturn({ result: 'ok' })
  .withDelay(1000) // 1 second delay
```

##### `withChunkInterval(ms)`

Sets the interval between each chunk in streaming output (simulates real streaming transmission).

```typescript
mock.when({ input: 'stream' })
  .thenStream(['Hello', ' ', 'World', '!'])
  .withChunkInterval(50) // 50ms between chunks
```

##### `withUsage(usage)`

Sets token usage.

```typescript
mock.when({ input: 'hello' })
  .thenReturn({ result: 'ok' })
  .withUsage({
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150 // optional, auto-calculated
  })
```

#### `mock.setDefaultResponse(response)`

Sets a default response (used when no rule matches). If no default response is set and no rule matches, throws: `No matching rule found. Use mock.when(...), mock.sequence(...), or mock.setDefaultResponse(...).`

```typescript
mock.setDefaultResponse({ result: 'default' })
```

#### `mock.setDefaultUsage(usage)`

Sets the default token usage for responses.

```typescript
mock.setDefaultUsage({ promptTokens: 10, completionTokens: 5 })
```

#### `mock.setDefaultDelay(ms)`

Sets the default response delay (ms).

```typescript
mock.setDefaultDelay(500) // 500ms default delay
```

#### `mock.sequence(steps)`

Defines a sequence of responses, returned in call order. Priority: Sequence > Rule Match > Default.

```typescript
mock.sequence([
  { type: 'json', content: { step: 'first' } },
  { type: 'json', content: { step: 'second' } },
  { type: 'json', content: { step: 'third' } },
])
```

#### `mock.setSequenceUsage(usage)`

Sets token usage for sequence responses.

```typescript
mock.setSequenceUsage([
  { promptTokens: 10, completionTokens: 5 },
  { promptTokens: 20, completionTokens: 10 },
])
```

#### `mock.setSequenceDelay(ms)`

Sets the delay for sequence responses (ms).

```typescript
mock.setSequenceDelay(200) // 200ms per sequence response
```

#### `mock.setCostCalculator(calculator)`

Custom cost calculation function, overriding the default token-based cost logic.

```typescript
mock.setCostCalculator((usage) => {
  return {
    usd: usage.promptTokens * 0.00003 + usage.completionTokens * 0.00006,
  }
})
```

#### `mock.calls`

Call recording API for inspecting Agent calls to the LLM.

```typescript
// Get all call records
const allCalls = mock.calls.all()

// Get call count
const count = mock.calls.count()

// Get first call
const firstCall = mock.calls.first()

// Get last call
const lastCall = mock.calls.last()

// Clear call records
mock.calls.clear()
```

**CallRecord structure**:
```typescript
interface CallRecord {
  messages: Message[]      // Messages sent to the model
  schema?: JsonSchema      // JSON Schema (if any)
  timestamp: number        // Timestamp
  index: number           // Call index (0-based)
}
```

#### `mock.reset()`

Resets all rules and call records.

```typescript
mock.reset()
```

#### `mock.adapter`

ModelAdapter instance for passing to `createAgent`.

```typescript
const agent = createAgent({
  id: 'test',
  model: mock.adapter,
  handler: async () => { /* ... */ }
})
```

## Complete Example

```typescript
import { createMockModel } from '@rejelly/core/testing'
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core'
import { z } from 'zod'

// Create Mock Model
const mock = createMockModel()

// Configure response rules
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

// Set default response
mock.setDefaultResponse({ result: 'default response' })

// Create test Agent
const TestAgent = createAgent({
  id: 'test_agent',
  model: mock.adapter,
  handler: async (props: { query: string }) => {
    equipSystem('You are an assistant')
    equipInstruction(`User query: ${props.query}`)
    
    const ResultSchema = z.object({
      answer: z.string()
    })
    
    return await promptAgent(ResultSchema)
  }
})

// Run test
const result = await TestAgent({ query: 'hello' })
console.log(result) // { answer: 'Hello, World!' }

// Check call records
const lastCall = mock.calls.last()
console.log(lastCall?.messages) // View messages sent to the model
console.log(mock.calls.count()) // Number of calls
```

## Type Definitions

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
  /** chunksOrObject: string[] or JsonValue; chunkSize only valid for objects, chars per chunk, default 1 */
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
  /** The last user message text (multimodal: image/video becomes "[image]"/"[video]") */
  lastUserMessage?: string
  /** Source of all user messages concatenated (same, text parts only) */
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

/** String or JSON-serializable value (object, array, primitive) */
type MockResponse = string | JsonValue

/** Stream input: string array (yield in order), or object/value (stringified and chunked by chunkSize) */
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
