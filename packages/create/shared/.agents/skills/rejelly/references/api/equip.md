# Equip (Input & Context)

This phase is responsible for building the System Prompt and Context Window.

## Prompt Building

### `equipSystem(text: string)`

Inserts a system-level instruction (highest priority). Multiple calls are concatenated in order into the System Prompt.

### `equipInstruction(content: string | ContentPart[])`

Inserts the current task instruction. Multiple calls are concatenated in order to form the complete task description.

Supports plain text (`string`) and multimodal content (`ContentPart[]` — text and image interleaved; `video` type is reserved, not yet enabled):

```typescript
// Plain text
equipInstruction('Analyze the following customer question:');

// Multimodal content
equipInstruction([
  { type: 'text', text: 'Please look at this chart:' },
  { type: 'image', image: { url: 'https://example.com/chart.png' } },
  { type: 'text', text: 'Is the trend in the chart rising or falling?' }
]);
```

## Tool Registration

### `equipTool(tool: ToolDefinition, options?: EquipToolOptions)`

Registers a tool in the tool list for the LLM to call during conversation.

**Execution flow:**

1. **Tool registration**: After registering a tool via `equipTool`, the framework passes the tool's description and parameter information (converted by the model adapter to the corresponding format, e.g., OpenAI function calling) to the LLM API, informing the LLM of the function details.

2. **Tool call decision**: When generating a response, the LLM may choose to call a tool. At this point, the LLM may skip the output schema and directly execute a tool call.

3. **Automatic execution**: When the LLM decides to call a tool, the framework automatically executes the corresponding handler function and returns the result to the LLM.

4. **Subsequent decision**: Based on the tool's result, the LLM decides whether to:
   - Continue using other tools (if more information is needed)
   - Return output matching the schema (if enough information has been gathered)

**Features:**

- Supports dynamic middleware (via `options.middleware`) for injecting Agent-context-dependent business logic.
- Must be re-registered after each reborn.
- Tool execution is automatic — the LLM can call tools directly without manual intervention.

**ToolDefinition interface:**

```typescript
interface ToolDefinition {
  name: string;                    // Tool name
  description: string;             // Tool description, tells the LLM when to use it
  parameters: z.ZodSchema;         // Parameter schema (defined with Zod)
  handler: (params: any) => Promise<any>;  // Tool execution function
  middlewares?: ToolMiddleware[];  // Static middleware (optional, added via augmentTool)
}

interface EquipToolOptions {
  middleware?: ToolMiddleware[];   // Dynamic middleware array (optional)
}
```

**Basic example:**

```typescript
equipTool({
  name: 'search',
  description: 'Search the web for real-time information',
  parameters: z.object({
    query: z.string().describe('Search keyword'),
    limit: z.number().optional().describe('Number of results to return')
  }),
  handler: async ({ query, limit = 10 }) => {
    return await searchAPI(query, limit);
  }
});
```

**Example with dynamic middleware:**

```typescript
// Define base tool
const BaseSearchTool: ToolDefinition = {
  name: 'search',
  description: 'Search the web for real-time information',
  parameters: z.object({ query: z.string() }),
  handler: async ({ query }) => await searchAPI(query),
};

// Use augmentTool to add static middleware (global reuse)
const SafeSearchTool = augmentTool(BaseSearchTool, [
  wrapLog(),            // Logging
  wrapRetry({ n: 3 })   // Retry mechanism
]);

// Use in Agent with dynamic middleware (context-dependent)
equipTool(SafeSearchTool, {
  middleware: [
    // Interceptor: sync results to Agent memory
    async (ctx, next) => {
      const result = await next();
      const [history, setHistory] = equipMemory('history', []);
      setHistory([...history, `Used ${ctx.toolName}: ${JSON.stringify(result)}`]);
      return result;
    },
    // Interceptor: risk control
    async (ctx, next) => {
      if (ctx.input.query.length > 100) {
        return "Query too long"; // Block execution
      }
      return await next();
    }
  ]
});
```

**External tool adapters:**

Rejelly provides adapter modules for integrating external tool ecosystems. See [Adapter](/en/api/adapter/) for details.

### `equipToolCallLoopMiddleware(middleware: ToolCallLoopMiddleware)`

Intervenes at the point **after the model has returned this round's `tool_calls`, but before executing the actual tools** (before the per-tool handler / dynamic `middleware` of `equipTool`). Used for filtering calls, authorization, rate limiting, or **short-circuiting** some calls with synthetic `ToolOutput[]` (which the framework maps to protocol-level tool messages).

**Differences from `equipTool` dynamic middleware:**

| | `equipToolCallLoopMiddleware` | `equipTool(..., { middleware })` |
|---|------------------------------|----------------------------------|
| Timing | Before the entire round of tool calls (cross-tool) | When a single tool is about to execute |
| Input | `ToolCallLoopContext` + `currentCalls` + `next(calls)` | `ToolContext` + `next()` |
| Output | `ToolOutput[]` (`callId` + `content`) | Return value of that tool's handler |

**Constraints:**

- **Must be called before `promptAgent()`** (same draft barrier as `equipTool`, otherwise `AfterPromptAgentError`).
- **Must not** modify the snapshot-participating system / instruction / schema of the current round; `ctx` is read-only (contains `toolTurns`, `originalCalls`, etc.).
- Multiple registrations follow an **onion** pattern: **earlier registration = outer layer**, `next(filteredCalls)` passes the filtered **`currentCalls`** inward; `ctx.originalCalls` always holds the model's original list. See [Core · equipToolCallLoopMiddleware](/en/api/core#equiptoolcallloopmiddlewaremiddleware).

**Type summary:**

```typescript
interface ToolCallLoopMiddleware {
  name: string;
  handler: (
    ctx: ToolCallLoopContext,
    currentCalls: ToolCall[],
    next: (calls: ToolCall[]) => Promise<ToolOutput[]>,
  ) => Promise<ToolOutput[]>;
  config?: Record<string, unknown>;
}
```

### Streaming Options Relocation

The old capability to write streaming options to the draft via equip has been removed (it was an ambient configuration implicitly read and modified by preset policies). The lifecycle has been relocated to two places:

- **`toolChoice`** (per-turn directive): Explicitly passed via `executeTurn(messages, { toolChoice })`. Preset policies (`promptChat` / `promptAgent`) **deliberately do not expose** it; if you need "force tool use," write a custom policy that decides `toolChoice` per turn.
- **`additionalOptions`** (temperature, top_p, etc. provider parameters): Generation-level parameters should be configured when **constructing the model adapter** (set once, effective for the entire run). To override per turn, custom policies can use `executeTurn(messages, { additionalOptions })`, forwarded via `callLLM` to `model.stream()`.

The `StreamOptions` type has also been removed; `ModelStreamOptions.{toolChoice, additionalOptions}` on the model adapter interface remain unchanged. See [Policy](./policy.md) for details.

### `equipMemory(key, initialVal)`

**Core Hook.** Retrieves memory. If this is a re-run triggered by `reborn`, returns the value from the last modification.

**⚠️ Important limitation**: Only JSON-serializable values can be stored.

**Basic usage:**

```typescript
// Basic usage
const [count, setCount] = equipMemory('counter', 0);

// setState supports two calling patterns:
setCount(10);                    // Directly set a new value
setCount(prev => prev + 1);      // Functional update

// Note: setCount does not affect the already-extracted count variable.
// If you need the new value in the current round, use a local variable or call equipMemory again
const newCount = count + 1;
setCount(newCount);
equipInstruction(`Current count: ${newCount}`);  // ✅ Use local variable
```

**Serialization constraints:**

`equipMemory` can only store JSON-serializable values.

- ✅ **Allowed types**: `string`, `number`, `boolean`, `null`, plain objects, arrays
- ❌ **Forbidden types**: `function`, `symbol`, `undefined`, class instances (`Date`, `Map`, `Set`, etc.), circular references

```typescript
// ✅ Correct usage
equipMemory('str', 'hello');
equipMemory('num', 42);
equipMemory('obj', { a: 1, b: 'test' });
equipMemory('arr', [1, 2, 3]);
equipMemory('nested', { a: { b: { c: 123 } } });

// ❌ Incorrect usage (throws error)
equipMemory('fn', () => {});           // function forbidden
equipMemory('date', new Date());        // class instance forbidden
equipMemory('map', new Map());          // class instance forbidden
equipMemory('symbol', Symbol('id'));    // symbol forbidden
equipMemory('undefined', undefined);    // undefined forbidden
```

**Behavior notes:**

- **Scope and lifecycle**: Bound to the **current Agent invocation**'s `ctx.memory` (in-memory only). It **survives `reborn`** (multiple generations within the same Agent invocation share reads/writes), but is **destroyed when the Agent returns** — it does not persist across different Agent calls or conversation turns. For cross-Agent / cross-session persistence, inject real database, Redis, or SDK clients via `runWith({ providers })` and read with `expectResource()`.
- **Write is immediate, read is a snapshot**: `setState` **immediately** updates the underlying `ctx.memory`, but does not backfill the local variable you already destructured. To observe the new value in the current round, call `equipMemory(key)` again, or use a local variable (see example above).
- Return value is a snapshot (deep clone) to prevent direct mutation of stored values.
- All values are validated and cloned on read/write to ensure immutability and serializability.
- If a value does not meet serialization requirements, an error is thrown on set.

**⚠️ Concurrency and multi-tool writes (avoid lost updates):**

A single model call may trigger **multiple tools** in parallel, all running on the **same** `ctx.memory`. If two handlers both "read a snapshot before `await` → write back the entire snapshot after `await`," the later write will overwrite the earlier one with a stale baseline — **silently losing one update** (classic lost update).

```typescript
// ❌ Dangerous: holding a snapshot across await and overwriting entirely; concurrent writes cause lost updates
const [board, setBoard] = equipMemory<Item[]>('board', []);
const snapshot = board;                  // snapshot before await
const extra = await fetchSomething();
setBoard([...snapshot, extra]);          // overwrites with stale snapshot

// ✅ Safe: functional update reads the latest value at write time — atomic read-modify-write under single thread
setBoard(prev => [...prev, extra]);
```

- **Always use functional updates for accumulation/derivation** `set(prev => ...)` — it synchronously reads the latest value on commit, so concurrent calls do not overwrite each other.
- **Parallel tool handlers writing to different keys** is also safe (different keys don't overlap); lost updates only happen when multiple handlers **snapshot-overwrite the same key**.
- For **aggregating results across multiple tools**, a safer place is in [`equipToolCallLoopMiddleware`](/en/api/core#equiptoolcallloopmiddlewaremiddleware) (sequential, sees the entire batch of tool outputs at once), or after `promptAgent` returns — neither has a concurrent window.

### `equipMemo(key, factory, deps)`

**Memoization Hook** (syntactic sugar, backed by `equipMemory`). Caches the result of an async factory function based on a dependency array. When dependencies are unchanged, returns the cached value; otherwise, executes the factory function and updates the cache. Useful for expensive async computations, API calls, and other scenarios needing cached results.

**⚠️ Important limitation**: The value returned by `factory` must be JSON-serializable.

**Basic usage:**

```typescript
// Basic usage: cache expensive async computation
const result = await equipMemo(
  'expensive-computation',
  async () => {
    // Perform expensive async operation
    return await computeHeavyData(input);
  },
  [input.id, input.version]  // Dependency array
);

// Cache API call result
const userData = await equipMemo(
  'user-data',
  async () => await fetchUser(userId),
  [userId]  // When userId unchanged, returns cached value directly
);

// Usage in Agent handler
handler: async (props) => {
  // First call: executes factory and caches result
  const data = await equipMemo('api-data', async () => {
    return await fetchAPI(props.endpoint);
  }, [props.endpoint]);
  
  // If props.endpoint is unchanged, subsequent reborns return cached value directly
  return data;
}
```

**How it works:**

- Cache key: uses internal prefix `__reagent_internal_memo__::` + `key`
- Cache structure: `{ deps: previous dependency array, value: previous computed result }`
- **Dependency comparison: deep compare (deepEqual)**. Objects with the same structure (e.g., config, params) are treated as unchanged — inline objects can be passed directly, reducing boilerplate without needing stable references.
  - **Why deep compare (rather than shallow compare like `equipResource`)**: Memo's cache (including `deps`) is stored via `equipMemory`, which deep clones on both reads and writes — reference identity is destroyed during cloning. Therefore `cache.deps[i]` is never reference-equal to the newly passed `deps[i]`. Object/array dependencies can only be compared **by value (deep)**; if shallow comparison (`Object.is`) were used, any non-primitive dependency would be judged as "changed" and the cache would never hit. This is also why `deps` must be serializable (they need to be cloneable). The difference from `equipResource` is not arbitrary naming, but a necessary consequence of their different storage models.
- Cache hit: When dependencies are unchanged, returns `cache.value` directly.
- Cache miss: When dependencies change or cache doesn't exist, executes `factory()` and updates the cache.

**Serialization constraints:**

Since `equipMemo` uses `equipMemory` for storage, the value returned by `factory` must be JSON-serializable.

- ✅ **Allowed types**: `string`, `number`, `boolean`, `null`, plain objects, arrays
- ❌ **Forbidden types**: `function`, `symbol`, `undefined`, class instances (`Date`, `Map`, `Set`, etc.), circular references

```typescript
// ✅ Correct usage
const data = await equipMemo('api-data', async () => {
  return { name: 'Alice', age: 30 };  // Plain object
}, [userId]);

// ❌ Incorrect usage (throws error)
const date = await equipMemo('date', async () => {
  return new Date();  // Date instance is not serializable
}, []);

const fn = await equipMemo('fn', async () => {
  return () => {};  // function is not serializable
}, []);
```

**Notes:**

- `factory` must be an async function (returns `Promise<T>`)
- The value returned by `factory` must be JSON-serializable (string, number, boolean, null, plain object, array)
- Dependencies should also be JSON-serializable
- Cache persists across reborn, but is recomputed when dependencies change
- **Dependency comparison**: Memo uses **deep compare**, convenient for inline objects like config, params — less boilerplate code

## Resource Management

### `equipResource(key, config)`

**Resource Management Hook** (syntactic sugar). The underlying mechanism is **not** `equipMemory`: previous `deps` are stored separately at runtime (not in `memory` snapshot, no JSON serialization); resource instances and metadata are in **`ctx.resources`** (two Maps: `active` / `metadata`). Manages resource lifecycle (create and destroy) based on a dependency array. When dependencies change, automatically destroys the old resource and creates a new one; when unchanged, returns the cached resource instance. Suitable for resources needing lifecycle management, such as database connections, file handles, network connections, etc.

Supports exposing resources to child Agents via `expose: true`, which can be retrieved by child Agents via `expectResource`.

**Basic usage:**

```typescript
// Database connection resource (private, visible only to the current Agent)
const db = await equipResource('db_conn', {
  create: async () => await connectDB(),
  destroy: async (conn) => await conn.close(),
  deps: [dbConfig.host, dbConfig.port]  // Auto-reconnect when config changes
});

// File handle resource
const file = await equipResource('file_handle', {
  create: async () => await openFile(path),
  destroy: async (handle) => await handle.close(),
  deps: [path]  // Auto-close old file and open new one when path changes
});

// Expose resource to child Agents
const db = await equipResource('database', {
  create: async () => await connectDB(),
  destroy: async (conn) => await conn.close(),
  deps: [],
  expose: true  // Key: allows child Agents to retrieve via expectResource('database')
});

// Usage in Agent handler
handler: async (props) => {
  // First call: create resource and cache
  const db = await equipResource('db', {
    create: async () => await connectDB(props.dbConfig),
    destroy: async (conn) => await conn.close(),
    deps: [props.dbConfig.host, props.dbConfig.port]
  });
  
  // If dbConfig is unchanged, subsequent reborns return the cached connection
  // If dbConfig changes, auto-closes the old connection and creates a new one
  return await db.query('SELECT * FROM users');
}
```

**ResourceConfig interface:**

```typescript
interface ResourceConfig<T> {
  /** Async function to create the resource */
  create: () => Promise<T>;
  /**
   * Async function to destroy/clean up the resource (optional).
   *
   * Omitting means the resource does not need teardown — it's a pure derived value,
   * or a borrowed handle the current Agent doesn't "own"
   * (e.g., an application-level connection pool injected via runWith({ providers })).
   * Omitting also means no global teardown is registered, and no destroy resource:op span is emitted.
   *
   * Whether destroy is provided is the signal for "own vs borrow": given = I own it, I close it;
   * omitted = I only borrow/derive.
   */
  destroy?: (resource: T) => Promise<void>;
  /** Dependency array (for cache invalidation; allows non-serializable values — see below) */
  deps: unknown[];
  /** Whether to expose this resource to child Agents (default: false, visible only to the current Agent) */
  expose?: boolean;
}
```

**How it works:**

- **deps storage**: The framework saves the previous `deps` at runtime (internally uses a prefixed key, **allows non-serializable values**, unlike `equipMemory` / `equipMemo`)
- **Resource and metadata**: Resource instances live under `ctx.resources.active[key]`; metadata lives under `ctx.resources.metadata[key]`, value is `{ expose, unregister?, destroyOnce? }` — `expose` is declaration-time visibility; `unregister` unregisters from global Teardown; `destroyOnce` is a per-instance at-most-once destroy gate (shared by both teardown and deps-change cleanup paths — even if both paths race, user's `destroy` runs at most once). When `destroy` is not provided, the latter two are `undefined`
- **Dependency comparison: shallow compare (React-style)**. Compares each item by `Object.is`; reference change = deps change. Suitable for non-serializable, side-effect-having entities (Sockets, handles, callbacks, etc.). Keeping stable references avoids unnecessary destroy+create.
  - **Why shallow compare (rather than deep compare like `equipMemo`)**: Resource's `deps` are stored by reference in `ctx.ephemeral` (**not cloned**), so reference identity is preserved across reborn — shallow comparison makes sense. Also, `deps` allows non-serializable values (Sockets, handles, closures, class instances), for which **deep comparison is impossible**. Therefore "shallow" is forced by the storage model and serializability constraints, not an inconsistency with `equipMemo` — each uses the only comparison semantics that work for its storage approach.
- When dependencies change:
  1. **Clean up old resource** (if exists):
     - **First**, unregister the old resource's teardown from the global Teardown queue, narrowing the race window with concurrent teardown destruction
     - Then, via the `destroyOnce` gate, call `destroy(old resource)` (even if racing with teardown, at most once); if the old resource has no `destroy`, skip destruction and remove directly
  2. **Create new resource**: Calls `create()` to create the new resource
  3. **Register in global Teardown** (only when `destroy` is provided): Registers the new resource's destroy function in the Agent's teardown queue
     - This ensures resources are auto-released when the Agent is closed directly
  4. **Update cache**: Saves the new resource, dependency array, and metadata (`expose` / `unregister` / `destroyOnce`)
- When dependencies are unchanged: directly returns the cached resource instance

**Automatic cleanup mechanism:**

- After creation, resources are automatically registered in the Agent's global Teardown queue
- When the Agent finishes execution (success or failure), all teardown functions are executed in LIFO order in a `finally` block
- This ensures resources are properly released even without a reborn trigger
- When dependencies change, the old resource's teardown is automatically unregistered to avoid double-destruction
- Resources without `destroy` (borrowed/derived) are not registered in teardown and are not cleaned up when the Agent ends

**Notes:**

- `create` must be async; `destroy` is **optional**, and when provided must also be async
- `destroy` receives the resource instance as a parameter and is responsible for cleanup (e.g., closing connections, releasing handles); omitting `destroy` means the resource is borrowed/derived and needs no cleanup (see `ResourceConfig` above)
- If `destroy` fails, a warning is logged but does not block new resource creation or Agent execution
- **`deps` allows non-serializable values** (functions, class instances, closures, `Symbol`, etc.), stored by reference at runtime; **shallow compare**, reference change = deps change
- Resources persist across reborn but are automatically rebuilt when dependencies change
- Suitable for resources requiring explicit cleanup (database connections, file handles, network connections), not for pure data caching (use `equipMemo` instead)
- Resource cleanup follows LIFO (last in, first out) order, ensuring resources with correct dependency ordering are cleaned up properly
- When **`expose: true`**, the resource is stored in the `ctx.providers` Map and child Agents can retrieve it via `expectResource`
- Even on cache hit, if `expose: true`, the resource is ensured to be in the `providers` Map (handles reborn scenarios)
- **Dependency comparison**: Resource uses **shallow compare (React-style, `Object.is` per item)**; `deps` may contain non-serializable values but require stable references (extract to external variables or use `useCallback`-like patterns), avoiding inline objects/anonymous functions that cause unnecessary rebuilds
- ⚠️ **Call order**: When using `expose: true`, call `equipResource` **before** calling the child Agent — otherwise, the resource is not yet registered in `providers` when the child Agent executes, and `expectResource` will throw a "resource not found" error
- For managing MCP Clients in `equipResource` and combining with `equipMCP`, see [Adapter · MCP](/en/api/adapter/mcp) for conventions and examples of child Agents using `expectResource` to retrieve exposed Clients

## Persistent State

Unlike **in-memory-only** `equipMemory` / `equipMemo` (which survive `reborn` but are destroyed when the Agent returns), cross-Agent / cross-session persistence should use `runWith({ providers })` to inject real database, Redis, or SDK clients and read them via `expectResource()`. Full details and examples in [Expect · Persistent State](/en/api/expect#persistent-state).

## Budget Control

> 📖 **Detailed documentation**: See [Budget](/en/api/budget) for hierarchical tracking, usage statistics, and `onUpdate` callbacks.

### `equipBudget(config)`

Registers a budget configuration (required). Adds the configuration to the current context's `budgetConfigs`. The `config.onUpdate` callback is invoked on each usage update (traversing the context chain). To query current usage, use `getUsageStats()`.

```typescript
equipBudget({
  onUpdate: ({ delta, aggregate }) => {
    console.log('Updated', aggregate.costs, aggregate.totalTokens);
  }
});
```

**BudgetUpdateArg / BudgetConfig:**

```typescript
interface BudgetUpdateArg {
  delta: UsageStats;    // Usage delta for this update
  aggregate: UsageStats; // Current context aggregate usage (self + sub-agents)
  own: UsageStats;      // Current context own usage
}

interface BudgetConfig {
  /** Callback on usage update, called sequentially along the context chain (required) */
  onUpdate: (arg: BudgetUpdateArg) => void;
}

interface BudgetState {
  own: UsageStats;       // Current Agent's own consumption
  aggregate: UsageStats;  // Current Agent + all sub-agents aggregated consumption
}

interface UsageStats {
  costs: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  items: UsageItem[];
}
```

## Scope Passing

### `equipScope(data)`

Provides environment variables (scope data) for child Agents. Data is layered onto the scope stack hierarchically; child Agents read it via `expectScope`. **Key-level shadowing**: child-layer keys shadow parent-layer keys (no deep merge). **Lifecycle**: Draft state — must be re-called after reborn.

**Value constraints**: Only JSON-serializable values are allowed, except `undefined`. `undefined` is allowed and **shadows the parent's value for the same key** during merge, useful for "clearing" upstream fields.

```typescript
// Parent Agent provides scope
handler: async () => {
  equipScope({
    userId: 'u_123',
    config: { debug: true }
  });

  // Child Agent can read this data
  await ChildAgent({ ... });
}

// Child layer uses undefined to shadow parent's same key, useful for clearing upstream values
equipScope({ theme: 'dark' });        // Parent
// Child: equipScope({ theme: undefined }) → merged result: theme is undefined
```

**Basic example (from expect-scope test):**

```typescript
// Parent provides, child reads
const ParentAgent = createAgent({
  id: 'parent',
  model: adapter,
  handler: async () => {
    equipScope({ userId: 'u_123', debug: true });
    return await ChildAgent({});
  },
});

const ChildAgent = createAgent({
  id: 'child',
  model: adapter,
  handler: async () => {
    const ctx = expectScope(z.object({
      userId: z.string(),
      debug: z.boolean(),
    }));
    // ctx.userId === 'u_123', ctx.debug === true
    return { done: true };
  },
});
```

**Example of undefined shadowing a previous value:**

```typescript
// Parent sets theme, child clears with undefined, grandchild reads as optional
const GrandchildAgent = createAgent({
  id: 'grandchild',
  model: adapter,
  handler: async () => {
    const ctx = expectScope(z.object({
      theme: z.string().optional(),
    }));
    expect(ctx.theme).toBeUndefined(); // Shadowed by child's undefined
    return { done: true };
  },
});

const ChildAgent = createAgent({
  id: 'child',
  model: adapter,
  handler: async () => {
    equipScope({ theme: undefined }); // Explicitly clear parent's theme
    return await GrandchildAgent({});
  },
});

const ParentAgent = createAgent({
  id: 'parent',
  model: adapter,
  handler: async () => {
    equipScope({ theme: 'dark' });
    return await ChildAgent({});
  },
});
```

**The following throw TypeError:**

```typescript
equipScope({ handler: () => {} });        // function forbidden
equipScope({ id: Symbol('id') });         // symbol forbidden
equipScope({ date: new Date() });         // class instance forbidden
equipScope({ items: new Map() });         // class instance forbidden
```

## Trace Attributes

### `equipTraceAttr(attrs: Record<string, unknown>, options?: EquipTraceAttrOptions)`

Attaches tracing attributes (span attributes) to the current Agent run. By default (`target: 'agent'`), these attributes are merged into the **`agent:end`** and each round's **`generation:end`** event's `trace.attributes`, facilitating filtering and aggregation by dimensions such as request ID, user ID, etc. in distributed tracing or logs.

**EquipTraceAttrOptions:**

```typescript
interface EquipTraceAttrOptions {
  /**
   * Attribute attachment target:
   * - 'agent' (default): Merged into draft, emitted with this agent's agent:end and each generation:end event
   * - 'local': Immediately merged into the current trace span
   * - 'root': Traverses up the context chain to the top-level (runWith) context, immediately merges into its span;
   *   visible on runWith:end (runWith:start has already been emitted). Useful for tagging the entire run's
   *   root span from a deeply nested child Agent.
   */
  target?: 'agent' | 'local' | 'root';
}
```

**Behavior:**

- Multiple calls merge into the same object: **same key → later overwrites earlier**, different keys accumulate.
- Only **JSON-serializable** values are supported (same constraint as `equipScope`), otherwise throws `TypeError`.
- **Lifecycle**: `target: 'agent'` (default) is Draft state — cleared on each reborn; if tagging is needed in the next round, call again. `'local'` / `'root'` are **written immediately** to the corresponding span and are not cleared by reborn.
- Calling with default `target: 'agent'` at the runWith root context (outside the Agent handler) triggers a warning — there is no `agent:end` event to attach to; use `{ target: 'local' }` or `{ target: 'root' }` instead.
- **Key naming**: Keys become OTLP span attributes as-is (no prefix). The `rejelly.` prefix is reserved by the framework — keys starting with it are skipped with a warning. Avoid reusing OTel semantic convention keys (`http.*`, `service.*`, `user.id`, etc.) to avoid confusion with OTel-aware backends.

**Differences from runWith's trace:**

- `runWith`'s `trace` option is used for **forwarding external links** (traceId, parentSpanId, root span name, initial attributes), taking effect when the root context is created.
- `equipTraceAttr` tags **inside the handler** on demand, ultimately reflected in the span of that agent's agent:end and each generation:end.

```typescript
handler: async (props) => {
  equipTraceAttr({ userId: props.userId, requestId: props.requestId });
  // ... subsequent agent:end / generation:end trace.attributes will include the above fields
  return await promptAgent(schema);
}

// Multiple calls: later overwrites earlier on same key, new keys merge
equipTraceAttr({ a: 1 });
equipTraceAttr({ b: 2 });
equipTraceAttr({ a: 3 });  // Final attributes: { a: 3, b: 2 }

// Tag the entire run's root span from a deeply nested child Agent (written immediately, visible on runWith:end)
equipTraceAttr({ runLabel: 'nightly-batch' }, { target: 'root' });
```
