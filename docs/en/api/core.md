# Core

## `createAgent(config)`

Defines a reusable Agent unit.

```typescript
import { createAgent, ModelAdapter } from '@rejelly/core';

// Assume an OpenAI adapter is already available
const openaiModel: ModelAdapter = createOpenAIAdapter({ modelId: 'gpt-5.6-luna' });

// Handler receives props (instructions, parameters) from the caller
export const SearchAgent = createAgent({
  id: 'search_agent',
  model: openaiModel, // ModelAdapter instance
  maxRetries: 3,   // Optional, max retries on promptAgent(schema) / expectValidator validation failure (default 3)
  handler: async (props) => {
     // ... logic code
     return result;
  }
});

// ✅ Agent as a Function: call directly, no .handler
// The framework automatically handles context creation, reborn loop, and other runtime details
const result = await SearchAgent({ topic: 'hello' });
```

**createAgent options:**

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `id` | `string` | ✅ | - | Unique Agent identifier, used for logging and persistence |
| `model` | `string \| ModelAdapter` | ❌ | - | Model: pass `ModelAdapter` instance for direct use; pass `string` to resolve at runtime from `runWith`'s `modelRegistry` (i.e., `shared.modelRegistry`) by id, useful for multi-tenant injection of models with rate-limiting and other middleware per tenant |
| `maxRetries` | `number` | ❌ | `3` | Max retries when promptAgent(schema) / expectValidator validation fails |
| `maxReborns` | `number` | ❌ | `100` | Max reborn count (counts **reborn events**, not generations: `N` reborns = `N+1` generations). Exceeding throws `RebornLimitExceededError`. A liveness guard against infinite reborn loops — typical cause: using handler-local variables as cross-generation counters that reset to zero on each reborn and never converge; use `equipMemory` for cross-generation counting (call `set` before `return reborn()`). Increase this value for legitimate deep reborn chains |
| `handler` | `(props) => Promise<Result>` | ✅ | - | Core logic function |

## `ModelAdapter` Interface

```typescript
interface ModelAdapter {
  /** Model identifier (for logging/debugging) */
  id: string;
  
  /** Model provider (optional) */
  provider?: string;
  
  /** Streaming LLM call */
  stream(messages: Message[], options?: ModelStreamOptions): AsyncGenerator<StreamEvent>;
  
  /** Cost calculator (optional); returns integers per billing unit, e.g. micro_usd, credit (consistent with Budget / equipBudget costs) */
  calculateCost?(usage: TokenUsage): Record<string, number>;
}

interface ModelStreamOptions {
  schema?: JsonSchema;      // Optional JSON Schema for structured output
  tools?: ToolDefinition[]; // Tool definitions available for this round
  toolChoice?: ToolChoice;  // Tool call strategy (paired with tools)
  signal?: AbortSignal;     // Optional AbortSignal for interrupting streaming output
  additionalOptions?: Record<string, unknown>; // Extended options forwarded to each adapter
}

/** Streaming tool call delta (similar to OpenAI streaming tool_calls, merged by index) */
interface ToolCallChunk {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
  extra?: Record<string, unknown>;
}

// Stream event types (Tagged Union)
type StreamEvent =
  | { type: 'text'; content: string }       // Text delta
  | { type: 'reasoning'; content: string }  // Reasoning/thinking delta (chain-of-thought models like DeepSeek-R1)
  | { type: 'tool_call'; toolCall: ToolCallChunk }  // Streaming tool call chunk (accumulated by index into a complete ToolCall)
  | { type: 'extra'; extra: Record<string, unknown> } // Extra metadata from the adapter/model
  | { type: 'usage'; usage: TokenUsage }    // Statistics (may appear multiple times during streaming)
  | { type: 'finish'; finishReason: FinishReason; usage?: TokenUsage }  // Stream end (typically the last event)
  | { type: 'error'; error: unknown };     // Streaming error

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  details?: {
    reasoningTokens?: number;   // Reasoning tokens (billing-related)
    cacheReadTokens?: number;   // Tokens read from prompt cache
    cacheWriteTokens?: number;  // Tokens written to prompt cache
    [key: string]: number | undefined;
  };
}

interface Message {
  role: MessageRole;
  content: MessageContent | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;  // Tool call ID (used only by tool role)
  name?: string;
  extra?: Record<string, unknown>;
}
```

`ToolDefinition` and `ToolChoice` in `ModelStreamOptions` match the types used by the framework's equip tool system and are exported by `@rejelly/core`. `MessageContent` is `string | ContentPart[]` (multimodal content including text, images, video), `FinishReason` values include: `stop`, `length`, `tool_calls`, `content_filter`, `error`, `unknown`.

**OpenAI Adapter implementation example:**

For production, **prefer** importing `createOpenAIAdapter` from `@rejelly/adapter-openai` (install — see [Adapter · Model](/en/api/adapter/model)), rather than copying the handwritten `stream` below. **The entire block below is for demonstration only**: to help understand how `ModelAdapter` and `calculateCost` (with `micro_usd` / `credit`) work with Budget.

**Using the adapter directly (recommended):**

```typescript
import { createOpenAIAdapter } from '@rejelly/adapter-openai';

const model = createOpenAIAdapter({
  modelId: 'gpt-5.6-luna',
  apiKey: process.env.OPENAI_API_KEY!,
  // Optional: integer Record for budget (e.g. micro_usd + credit); see demo below
  // calculateCost: (usage) => ({ ... }),
});
```

**Hand-written sample:**

```typescript
const openaiAdapter: ModelAdapter = {
  id: 'gpt-5.6-luna',
  provider: 'openai',

  async *stream(messages, options) {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.6-luna',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      response_format: options?.schema
        ? { type: 'json_schema', json_schema: options.schema }
        : undefined,
    }, {
      signal: options?.signal,
    });
    
    let usage: TokenUsage | undefined;
    for await (const chunk of response) {
      if (options?.signal?.aborted) {
        throw new Error('Aborted');
      }
      
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        yield { type: 'text', content: text };
      }
      
      if (chunk.choices[0]?.finish_reason === 'stop' && usage) {
        yield { type: 'usage', usage };
      }
    }
  },
  
  calculateCost(usage) {
    // GPT-5.6 Luna: $1/1M input, $6/1M output — integer micro USD per token (see budget.md / model-pricing examples)
    const microUsd = Math.round(usage.promptTokens * 1 + usage.completionTokens * 6);
    if (microUsd === 0) return {};
    // Credit is calculated based on micro_usd (not the number of tokens), with 1 credit approximately equal to 1 milli-USD.
    const MICRO_USD_PER_CREDIT_PARITY = 10_000;
    // Margin >= 1: commercial premium so internal credits do not undercharge vs provider cost (tune per product)
    const CREDIT_MARGIN = 1.15;
    const credit = Math.ceil((microUsd / MICRO_USD_PER_CREDIT_PARITY) * CREDIT_MARGIN);
    return { micro_usd: microUsd, credit };
  }
};
```

## `augmentModel(model, middlewares)`

Enhances a ModelAdapter using an onion model (composed right-to-left, executed outside-to-inside).

```typescript
import { augmentModel } from '@rejelly/core';
import { withSimpleLimit } from '@rejelly/limit-model';

// Assuming user has implemented withLog for logging before and after requests
const openaiAdapter = createOpenAIAdapter({ modelId: 'gpt-5.6-luna' });

const enhancedModel = augmentModel(openaiAdapter, [
  withSimpleLimit({ rpm: 60, concurrency: 5 }),  // Rate limiting (from limit-model)
  withLog(),  // Logging
]);

// Onion model: middlewares are composed right-to-left, executing request through outermost to innermost, response returns the same way
// request  → limit → log → openai
// response ← limit ← log ← openai
```

## `augmentTool(tool, middlewares)`

Adds static middleware to a ToolDefinition ("burned into" the tool definition — define once, reuse globally). These static middlewares execute after dynamic middlewares (from `equipTool`'s `middleware` option) and before the handler.

```typescript
import { augmentTool, equipTool } from '@rejelly/core';

const BaseSearchTool: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  handler: async ({ query }) => await searchAPI(query),
};

const SafeSearchTool = augmentTool(BaseSearchTool, [
  wrapLog(),            // Outer: logging
  wrapRetry({ n: 3 })   // Inner: retry mechanism
]);

// Use in Agent
const ResearchAgent = createAgent({
  id: 'researcher',
  model: enhancedModel,
  handler: async (props) => {
    equipTool(SafeSearchTool);
    equipTool(SafeSearchTool, {
      middleware: [
        async (ctx, next) => {
          const [history, setHistory] = equipMemory('history', []);
          const result = await next();
          setHistory([...history, `Used ${ctx.toolName}`]);
          return result;
        }
      ]
    });
    return await promptAgent(ResultSchema);
  }
});
```

## `equipToolCallLoopMiddleware(middleware)`

### Internal flow of `promptAgent` and the middleware insertion point

A single `promptAgent(schema)` drives a "model request → parse response" loop within a **single Generation**, until a structured output matching the schema is obtained (or failure). A typical flow can be summarized as:

1. **First packet and subsequent turns**: Calls the model's streaming interface with the current draft (system, instruction, tools, history messages, etc.).
2. **If the model returns `tool_calls`**: The framework enters **one step** of the **tool call loop** — first running the **`ToolCallLoopMiddleware` chain** (if any registered), then executing each tool's handler (including `equipTool` dynamic / `augmentTool` static middleware) for the call list, converting results into tool messages written back to the conversation, and continuing the model request.
3. **If the model returns final content matching the schema**: The loop ends, `promptAgent` returns the parsed result.
4. If more rounds of "model → tool → model" are needed, repeat steps 2–3 until the end condition is met or the framework limit is reached.

**Actual position of this middleware**: Only at **step 2** above, and only within the **`promptAgent` internal** handling of "this round's `tool_calls` from the model" — i.e., **before** handing this batch to the underlying `executeToolOutputs` for execution, filtering or short-circuiting the **entire batch** of `ToolCall[]`. It does not participate in composing system/instruction, nor does it replace the per-tool `ToolMiddleware`.

> **⚠️ Scope: tool call loop inside promptAgent, NOT "global tool execution"**
>
> `ToolCallLoopMiddleware` is bound to **`promptAgent`'s built-in tool round-trip loop** (corresponding one-to-one with tool rounds in the model conversation). It does **not** trigger when tools are executed through other entry points.
>
> For example: when **directly executing** a `ToolDefinition` via **`callTool(tool, args)`** in code, it goes through the single-tool core path and does **not** pass through `equipToolCallLoopMiddleware`. Similarly, any path that does not go through "model produces `tool_calls` → `promptAgent` internally dispatches execution" will not execute Loop middleware. If unified interception is needed for "manual tool invocation" scenarios, handle it at the single-tool **`equipTool(..., { middleware })` / `augmentTool`** level, rather than relying on Loop middleware. (Note: `callTool` directly returns the handler's raw output, and on failure it **throws** — no fallback to string.)

**Registration semantics (connecting to above):** `equipToolCallLoopMiddleware` inserts a layer at step 2 above — after the model has produced `tool_calls` but **before** entering each tool's handler / single-tool middleware. It is unrelated to "modifying system / instruction / schema": the middleware **cannot** modify the prompt and schema that have already participated in hashing and snapshotting for this round. It only acts on the **jump before the entire batch of tool calls executes**, suitable for rate limiting, authorization, filtering calls, or **short-circuiting** some calls with synthetic `ToolOutput` (which the framework then converts to protocol-layer `role: "tool"` messages).

**Must be called before `promptAgent()`** (same draft barrier as `equipTool`; violation throws `AfterPromptAgentError`).

**Execution order (onion, consistent with `equipTool` dynamic middleware):** Array order: **earlier registrations are outer layers**, later ones are closer to actual execution. When the outer layer calls `next(filteredCalls)`, the inner layer receives **`currentCalls` as the filtered list**; the outermost layer's first received `currentCalls` matches `ctx.originalCalls` (the model's original `tool_calls` for this round). `ctx` is a read-only snapshot where `originalCalls` is always the model's request; **the `currentCalls` parameter is passed through the middleware chain**.

If interception only passes "approved" calls to `next(filtered)` but **does not** provide synthetic `ToolOutput` for the intercepted calls, the tool results for this batch will be fewer than the number of `tool_calls` the model requested, and the conversation cannot align. After merging middleware return values, the framework validates: **each `ToolCall.id` in the current batch must have exactly one corresponding `ToolOutput` with matching `callId`**; if any are missing and you did not provide fallback, a **`LoopMissingToolOutputError`** is thrown (exported by `@rejelly/core`, checkable via `isLoopMissingToolOutputError`).

The correct approach: **Splitting** → call `next` on the approved list to get real execution results → **merge with the synthetic results from the blocked side** before `return`, ensuring "N inputs = N outputs."

```typescript
import { equipToolCallLoopMiddleware } from '@rejelly/core';

equipToolCallLoopMiddleware({
  name: 'rate-limit-search',
  handler: async (ctx, currentCalls, next) => {
    const validCalls = [];
    const blockedOutputs = [];

    // 1. Splitting: approve legitimate calls, intercept illegal ones with synthetic output
    for (const call of currentCalls) {
      if (call.name === 'search') {
        blockedOutputs.push({
          callId: call.id, // Must return the callId
          content: JSON.stringify({
            error: 'Search tool is currently rate-limited and blocked.',
          }),
        });
      } else {
        validCalls.push(call);
      }
    }

    // 2. Pass approved calls down to get real execution results
    const realOutputs = validCalls.length > 0 ? await next(validCalls) : [];

    // 3. Must merge! Ensure N inputs correspond to N outputs
    return [...realOutputs, ...blockedOutputs];
  },
});
```

**`ToolCallLoopMiddleware` shape summary:**

```typescript
handler: (
  ctx: ToolCallLoopContext,
  currentCalls: ToolCall[],
  next: (calls: ToolCall[]) => Promise<ToolOutput[]>,
) => Promise<ToolOutput[]>;
```

- **`ctx`**: Read-only fields including the current loop step **`step`**, `systemInstruction`, `instruction`, completed round **`toolTurns`** (structured history), and this round's original model request **`originalCalls`**, etc.
- **`currentCalls`**: The actual call list received by the current layer (may be shorter after outer-layer filtering).
- **Return value**: Same as `next()`, a **`ToolOutput[]`** (`callId` + `content`) — the framework handles mapping to tool messages sent to the model; the middleware does not need to construct `role` / `tool_call_id`.

## `augmentAgent(agent, middlewares)`

Adds static middleware to an AgentFunction (executed in an onion model when the Agent is called).

```typescript
import { augmentAgent } from '@rejelly/core';

const BaseAgent = createAgent({
  id: 'researcher',
  model: enhancedModel,
  handler: async (props) => {
    equipTool(SafeSearchTool);
    return await promptAgent(ResultSchema);
  }
});

const LoggedAgent = augmentAgent(BaseAgent, [
  {
    name: 'log',
    handler: async (ctx, next) => {
      console.log(`Agent ${ctx.agentId} called with`, ctx.props);
      const result = await next();
      console.log(`Agent ${ctx.agentId} returned`, result);
      return result;
    }
  },
  {
    name: 'monitor',
    handler: async (ctx, next) => {
      const start = Date.now();
      const result = await next();
      const duration = Date.now() - start;
      console.log(`Agent ${ctx.agentId} execution time: ${duration}ms`);
      return result;
    }
  }
]);

// Execution order (onion model, composed right-to-left):
// request  → log → monitor → BaseAgent handler
// response ← log ← monitor ← BaseAgent handler
```

**ModelMiddleware Interface:**

```typescript
interface ModelMiddleware {
  /** Middleware name (for debugging and logging) */
  name: string;

  /** Wrapping logic */
  wrap: (inner: ModelAdapter) => ModelAdapter;
}
```

**ToolMiddleware Interface:**

```typescript
interface ToolMiddleware {
  /** Middleware name (for debugging and logging) */
  name: string;

  /** Middleware handler function */
  handler: (ctx: ToolContext, next: () => Promise<unknown>) => Promise<unknown>;

  /** Optional configuration snapshot (for debugging/display) */
  config?: Record<string, unknown>;
}

interface ToolContext {
  toolName: string;
  input: any;
  parameters: z.ZodTypeAny;
  description: string;
  metadata: {
    agentId: string;
    sessionId?: string;
    traceId?: string;
  };
  readonly definition: ToolDefinition;
}
```

**Built-in model middlewares:**

- **Rate limiting**: From `@rejelly/limit-model`, provides **`withLimit(options)`** (Rule-level, pluggable store) and **`withSimpleLimit(options)`** (rpm/tpm/concurrency simplified wrapper).

```typescript
import { augmentModel } from '@rejelly/core';
import { withSimpleLimit } from '@rejelly/limit-model';

const limitedModel = augmentModel(baseModel, [
  withSimpleLimit({ rpm: 60, tpm: 90000, concurrency: 5, key: 'my-model' }),
]);
```

Full API (rule types for `withLimit`, MemoryStore / RedisStore selection and multi-process warnings, Redis Cluster hash tag, multi-tenant example, error types) see [Limit Model](/en/api/limit-model).

**AgentMiddleware Interface:**

```typescript
interface AgentMiddleware<Props = unknown, Result = unknown> {
  /** Middleware name (for debugging and logging) */
  name: string;

  /** Middleware handler function */
  handler: (
    ctx: AgentMiddlewareContext<Props>,
    next: () => Promise<Result>
  ) => Promise<Result>;
}

interface AgentMiddlewareContext<Props = unknown> {
  /** Agent ID */
  agentId: string;
  /** Props when the Agent was called */
  props: Props;
}
```

> **⚠️ AgentMiddleware execution timing and idempotency**
>
> `AgentMiddleware` runs **after ctx creation, before handler execution**.
> In reborn scenarios, it executes **multiple times** per generation — therefore do not place non-idempotent or explicitly non-repeatable tasks (e.g., one-time billing, non-reentrant external writes) inside middleware, unless you provide deduplication / idempotency protection.

**Tool middleware execution order:**

When a tool has both static middleware (added via `augmentTool`) and dynamic middleware (added via `equipTool`), the execution order is:

```
Dynamic (outer) → Static (middle) → Handler (inner)
```

Rationale:
- Static middleware (e.g., retry) should be closer to the handler, preventing network jitter from causing dynamic middleware (e.g., memory writes) to execute repeatedly
- Dynamic middleware can access Agent context (memory, scope, etc.), suitable for business logic

> **⚠️ Layer by replay safety (implicit contract — must follow this)**
>
> The true basis for this order is not "who defined first" but **idempotency**: **replayable** logic must be innermost, wrapping only the replayable handler; **non-reentrant side effects** must be outermost, outside the replay boundary. Accordingly:
>
> - **Retry / backoff / circuit-breaker and other replayable logic → put in `augmentTool` static layer (inner)**. A single jitter only replays the handler itself, without re-triggering outer side effects.
> - **Non-reentrant side effects (deduction, memory writes, counting, logging) → put in `equipTool({ middleware })` dynamic layer (outer)** — executed once per logical call.
>
> Putting retry in the dynamic layer (outer) would cause a single network jitter to **re-trigger** all inner side effects (double billing, lost updates, etc.). The layer names (static/dynamic) themselves do not imply this contract — placing them wrong will not cause errors, but the above mapping must be followed.

**Agent middleware execution order:**

Agent middleware uses an onion model, composed right-to-left, executed outside-to-inside:

```
Middleware[0] (outer) → Middleware[1] → ... → Handler (inner)
```

Middleware can access the Agent ID and the current call's props, making it suitable for logging, monitoring, permission checks, and similar concerns.

## `promptAgent(schema)`

Executes an LLM call and returns output conforming to the schema definition, with automatic type inference.

**Generation and a single promptAgent:** A **Generation** is one execution round of the Agent: the framework opens a new Generation each time before entering the handler (one round in the reborn loop), resets the draft (equip/expect, etc.), collects all equip/expect in this round, and initiates one LLM call. Therefore **each Generation can only call `promptAgent()` once**; subsequent calls within the same handler throw `PromptAgentAlreadyCalledError`. For multiple LLM calls, split them into multiple rounds via `reborn` (one Generation per round, one `promptAgent()` per Generation).

> **⚠️ Key rule: call order constraints**
> 
> **Functions that must be called before `promptAgent()`** (violating order within the same Generation throws `AfterPromptAgentError`):
> 
> - `equipSystem()` - Must be before promptAgent
> - `equipInstruction()` - Must be before promptAgent
> - `equipTool()` - Must be before promptAgent (e.g., MCP's `kit.inject()` internally calls `equipTool`, also subject to this constraint)
> - `equipToolCallLoopMiddleware()` - Must be before promptAgent (registers the "before tool execution" loop middleware, same draft barrier as Prompt-composing equip)
> - `equipBudget(config)` - Must be before promptAgent
> - `expectValidator()` - Must be before promptAgent
> - `onStream()` - Must be before promptAgent
> 
> **Functions that do NOT need to be called before `promptAgent()`:**
> 
> - `equipMemory()` / `equipMemo()` - Bound to **Agent-level** `ctx.memory` (in-memory only, lives for the single Agent invocation, survives reborn, destroyed on Agent return; cross-Agent / cross-session persistence uses `runWith({ providers })` to inject real persistent clients read via `expectResource()`). Can be called at any time within the Generation (including first-time key registration, including after promptAgent), used for cross-reborn read/write state; **not** subject to `AfterPromptAgentError` (unlike draft equip for prompt building)
> - `equipScope()` - Must be called before invoking a sub-agent (unrelated to promptAgent)
> - `expectScope()` - Can be called anywhere (for reading parent Agent's scope)
> - `expectResource()` - Can be called anywhere (for reading parent Agent's exposed resources)
> 
> **Rationale**:
> - **promptAgent-related**: The framework collects all configured draft that participates in prompt building (system/instruction/tools/expect/onStream, etc.) when calling `promptAgent()`, builds the complete Prompt, and sends it to the LLM. If any API from the "must be before" list above is called after `promptAgent()` (violating order), `AfterPromptAgentError` is thrown directly. `equipMemory` / `equipMemo` (memory-based), `expectScope` / `expectResource` (reading dependencies, not draft) do not participate in this barrier.
> - **Sub-agent related**: `equipScope()` provides scope for sub-agents, must be called before invoking a sub-agent — unrelated to `promptAgent()`.
> - **Reading dependencies**: `expectScope()` and `expectResource()` read scope and resources provided by the parent Agent, can be called anywhere (including after promptAgent).
> - **Dependency array comparison**: `equipMemo` uses **deep compare** (convenient for inline objects like config, params — less boilerplate); `equipResource` uses **shallow compare (React-style)**, and its **`deps` allows non-serializable values** (class instances, closures, symbol-bearing references, etc. — different from `equipMemo`'s pure-data orientation; suitable for non-serializable, side-effect-having entities). See [Equip](/en/api/equip) for details.

**Call order example:**

```javascript
handler: async (props) => {
  // ============ 1. Equip Phase (must be before promptAgent) ============
  equipSystem('You are an assistant');
  equipInstruction('Answer the question');
  const [state, setState] = equipMemory('history', []);
  
  // ============ 2. Expect Phase (must be before promptAgent) ============
  // Use expectValidator to validate LLM output
  expectValidator((data) => {
    if (!data.answer || data.answer.length < 10) {
      return 'Answer too short, please elaborate';
    }
    return true;
  });
  
  // Use onStream to listen to Agent-level stream events
  onStream(async (stream) => {
    for await (const event of stream) {
      if (event.type === 'structured_data') {
        console.log('Structured stream result:', event.status, event.data);
      }
    }
  });
  
  // ============ 3. Call LLM ============
  // promptAgent(schema) directly defines structured output with automatic type inference
  const output = await promptAgent(z.object({ answer: z.string() }));
  
  // ============ 4. Business Logic (after promptAgent) ============
  // ❌ Can no longer call equip/expect/onStream that would be included in this round's Prompt (throws AfterPromptAgentError)
  // equipInstruction('Additional instruction'); // ❌ AfterPromptAgentError
  // expectValidator(...); // ❌ AfterPromptAgentError
  // ✅ equipMemory can still read/write (e.g., record results, count)
  // const [n, setN] = equipMemory('post_prompt_count', 0);
  
  // ✅ Business logic validation (using plain if checks)
  if (someBusinessCondition) {
    return reborn(); // Re-execute handler
  }
  
  return output;
}
```

**Note the distinction:**
- `expectValidator` - validates **LLM output**, must be before promptAgent
- Business logic validation - validates **handler's final result**, use plain if checks, after promptAgent

## `onStream(consumer, options?)`

Listens to Agent-level stream events within the current Generation. `onStream` does not expose the raw events of the underlying `ModelAdapter.stream()` directly, but provides a higher-level multicast stream on top of the policy / turn / tool loop.

**Must be called before `promptAgent()` / `promptChat()`**; otherwise throws `AfterPromptAgentError`.

**Function signature:**

```typescript
onStream(
  consumer: (stream: AsyncGenerator<AgentStreamEvent>) => void | Promise<void>,
  options?: {
    signal?: AbortSignal;
    awaitOnEnd?: boolean; // Default true
  }
): void;
```

**`options` explanation:**

- `signal`: User-defined cancel signal; merged with the current Generation's internal signal — if either aborts, the consumer ends.
- `awaitOnEnd`: Whether to wait for the consumer's own cleanup logic when the Generation ends. Default `true`; when `true`, the framework awaits the consumer's Promise when the Generation closes. Pure UI fire-and-forget consumers can set this to `false`.

**Lifecycle semantics:**

- `onStream` is bound to the **current Generation** and does not survive reborn.
- The consumer starts after `promptAgent()` / `promptChat()` crosses the draft barrier; even if no stream events follow (e.g., model call fails immediately), the consumer receives an end signal, and `finally` still executes.
- When the current Generation ends (normal return, error, cancellation, reborn), the framework actively closes that Generation's stream.

**Event model:**

```typescript
type AgentStreamEvent =
  | { type: 'turn_start'; turnIndex: number }
  | {
      type: 'text';
      turnIndex: number;
      delta: string;
    }
  | { type: 'reasoning'; turnIndex: number; delta: string }
  | {
      type: 'structured_data';
      turnIndex: number;
      status: 'partial' | 'complete' | 'error';
      data: Partial<unknown>;
      isValid: boolean;
    }
  | { type: 'tool_call_stream'; turnIndex: number; chunk: ToolCallChunk }
  | { type: 'tool_call'; turnIndex: number; toolCall: ToolCall }
  | { type: 'usage'; turnIndex: number; usage: TokenUsage }
  | { type: 'extra'; turnIndex: number; extra: Record<string, unknown> }
  | {
      type: 'turn_done';
      turnIndex: number;
      finishReason: FinishReason;
    }
  | { type: 'error'; turnIndex: number; error: unknown };
```

**Key event descriptions:**

- `turn_start`: A prompt turn begins; suitable for clearing the previous turn's local UI state.
- `text`: Text delta; tool parameter streaming uses the separate `tool_call_stream` event.
- `structured_data`: Structured parsing result from the current text buffer.
  - `status: 'partial'`: Stream not yet ended, currently an intermediate state.
  - `status: 'complete'`: Stream ended, final structured result is valid.
  - `status: 'error'`: Stream ended, but final structured result is invalid or incomplete.
- `tool_call_stream`: Underlying tool call chunks, preserving raw fragments.
- `tool_call`: Framework has merged chunks into a complete `ToolCall`.
- `extra`: Extra metadata from the adapter/model.
- `turn_done`: Current turn completed; useful for transitioning from "streaming state" to "static state."

**Common UI strategy: output `text` first, once `structured_data` is received, stop subsequent plain `text` for this turn.**

This is because both usually come from the same model output segment, and `structured_data` typically provides a structured view covering the same content; rendering both simultaneously often creates duplication.

**Example:**

```typescript
handler: async () => {
  onStream(
    async (stream) => {
      let sawStructuredData = false;
      for await (const event of stream) {
        switch (event.type) {
          case 'turn_start':
            sawStructuredData = false;
            resetTurnUI(event.turnIndex);
            break;
          case 'text':
            if (!sawStructuredData) {
              appendPlainText(event.delta);
            }
            break;
          case 'structured_data':
            sawStructuredData = true;
            renderForm(event.data, {
              status: event.status,
              isValid: event.isValid,
            });
            break;
          case 'tool_call':
            console.log('Complete tool call:', event.toolCall);
            break;
          case 'turn_done':
            finishTurn(event.turnIndex, event.finishReason);
            break;
        }
      }
    },
    { awaitOnEnd: true },
  );

  return await promptAgent(z.object({ answer: z.string() }));
};
```

## `promptChat()`

Executes the standard chat policy, returning the model's final text and messages newly added in this round.

**Differences from `promptAgent(schema)`:**

- `promptChat()` returns `{ data: string, delta: Message[] }`, where `data` is the final text, and `delta` contains messages newly added in this round that can be persisted.
- `promptChat()` follows the chat policy's multi-round tool loop; `promptAgent(schema)` is for structured output.
- `promptChat()` also depends on the already-equipped system/instruction/tools for this round.

**Tool loop rules:**

- The preset policy does **not** set `toolChoice` (the model decides whether to call tools by default policy); if "force tool use" is needed, write a custom policy controlled via `executeTurn({ toolChoice })` per turn. Generation-level parameters (temperature, etc.) are configured when constructing the model adapter.
- Each round with `tool_calls` appends an assistant message, then executes tools and writes tool messages back to the conversation, continuing to the next round.

**Termination and exceptions:**

- Ends when the model returns regular content that passes validator checks, returning `{ data, delta }` (if content is not a string, treated as empty string).
- When `maxTurnSteps` is reached without content, throws `ToolLoopExceededError` (the independent `TurnBudgetExceededError` is the `executeTurn` layer's total budget guardrail — validation retries count toward it; see [Policy - Two-Layer Turn Budget](policy.md#two-layer-turn-budget)).

## `dumpSnapshot()`

Exports a snapshot of the current Agent execution state for persistence and future replay. API imported from `@rejelly/core/debugger`. Usage, return value, and notes see [Time Travel](./time-travel.md#dumpsnapshot).

## `runWith(fn, options?)`

Executes a function at the top level; optionally accepts a snapshot for context restoration. Without a snapshot, executes directly; with a snapshot, restores the root context from the snapshot first, then executes. Snapshot restoration, replay mechanism, and complete examples see [Time Travel](./time-travel.md#runwithfn-options-and-snapshots).

```typescript
import { runWith } from '@rejelly/core';

// Normal execution (no snapshot)
const result = await runWith(async () => {
  const agent = createAgent({ ... });
  return await agent({ input: 'test' });
});

// Execute with snapshot restoration (snapshot from dumpSnapshot or restoreSnapshot in @rejelly/core/debugger)
const resultFromSnapshot = await runWith(async () => { ... }, { snapshot });

// Bind with external cancel source (e.g., HTTP Request, UI "Stop" button): after abort, the root context's signal synchronously enters aborted state; subsequent model calls and cancelable tools receive it
const ac = new AbortController();
const resultWithSignal = await runWith(
  async () => {
    const agent = createAgent({ ... });
    return await agent({ input: 'test' });
  },
  { signal: ac.signal },
);
// Call ac.abort() elsewhere to cancel async work along this run's chain
```

**Function signature:**

```typescript
export function runWith<R>(
  fn: () => Promise<R>,
  options?: RunWithOptions<void>
): Promise<R>;

export function runWith<P, R>(
  fn: (props: P) => Promise<R>,
  options?: RunWithOptions<P>
): Promise<R>;

interface RunWithOptions<P = unknown> {
  /** Initial props, passed to fn */
  initialProps?: P;
  /** Inject snapshot for context restoration; if provided, restores root context from snapshot before execution */
  snapshot?: AgentSnapshot;
  /** Custom trace event emitter; only needs to implement emit(event) */
  eventBus?: TraceEventEmitter;
  /** Root-injected dependencies; readable via expectResource(key) */
  providers?: Record<string, unknown>;
  /** Root context model adapter (Agents on the chain without a specified model can inherit from parent) */
  model?: ModelAdapter;
  /** Model registry: id -> ModelAdapter. Injected into root context's shared.modelRegistry; Agents with model as string resolve at runtime from this */
  modelRegistry?: Record<string, ModelAdapter>;
  /** Whether to enable snapshots (default IS_DEV); when disabled, dumpSnapshot throws, recordJournal/saveChildFrame return immediately */
  enableSnapshot?: boolean;
  /** Distributed tracing: traceId, parentSpanId, global attributes */
  trace?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, unknown> };
  /** Optional; linked with root context AbortSignal (e.g., request cancellation, user abort). When external aborts, root context signal enters aborted with same reason */
  signal?: AbortSignal;
}
```

**Brief explanation:**

- **No snapshot**: Directly executes `fn`, no context restoration.
- **With snapshot**: Restores root context (memory, replay cache, etc.) from the snapshot's root frame, then executes `fn`; child Agents auto-restore from `snapshot.children`.
- **modelRegistry**: A dictionary of id → ModelAdapter, injected into the root context's `shared.modelRegistry`, shared across the chain. When an Agent's `model` is a string, it resolves at runtime from this; throws `ModelRegistryNotFoundError` if id does not exist.
- **enableSnapshot**: Default `IS_DEV` (true in dev/test). When false, no journal recording, no child frame saving, and `dumpSnapshot()` throws; see [Time Travel - enableSnapshot](./time-travel.md#time-travel).
- **signal**: The passed `AbortSignal` is connected to the root `createAgentContext`: once externally `abort`ed, the root context's `controller` receives the same reason, `ctx.signal` enters aborted; child Agents still cascade parent signal by existing rules. Useful for aligning with HTTP `Request.signal`, front-end stop buttons, and other cancel sources.

**Integration with `enableReview()`:**

- If Trace needs to be reported to Review Server in real time, call `enableReview()` during app startup (API see [debug.md](./debug.md#review-exporter)); it does not conflict with `runWith()` — trace events produced within `runWith` automatically flow into the enabled Review exporter.
- In Next.js / Vite HMR / local hot-reload scenarios, module initialization code may execute repeatedly, causing `enableReview()` to be registered multiple times, leading to **duplicate reporting**. Consumers should perform **one-time registration / idempotency protection** (e.g., attach to a `globalThis` symbol marker, enabling only once).

## `restoreSnapshot(trace, options?)`

Restores an AgentSnapshot from a linear event trace array (TraceEvent[]) for time travel. API imported from `@rejelly/core/debugger`. Signature, anchor modes, usage examples, and error handling see [Time Travel](./time-travel.md#restoresnapshottrace-options).
