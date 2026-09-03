# Time Travel

Snapshots enable persistence, restoration, and replay of execution state, supporting checkpoint resume, recovery from event traces, and prompt/tool cache replay based on `contentHash`. Related APIs are imported from `@rejelly/core/debugger`; `runWith` is imported from `@rejelly/core`.

> **Warning: Snapshot throws by default in production.**

**enableSnapshot:** The root context's `enableSnapshot` is determined by `runWith`'s `options.enableSnapshot`, which defaults to `IS_DEV` (`true` when `NODE_ENV === 'development'` or `'test'`; the default can be overridden via `runWith` options). When `enableSnapshot` is `false`: journal recording and child Agent frame saving are both skipped; calling `dumpSnapshot()` throws `SnapshotDisabledError`. If snapshots are needed in **production**, collect trace events (TraceEvent) during runtime and use `restoreSnapshot(trace.events)` to reconstruct the snapshot from the event timeline afterward, then replay and debug locally.

---

## `dumpSnapshot(options?)`

Exports a snapshot of the current Agent execution state for persistence and future replay. The function automatically retrieves state from the current context, so no context argument is required; optional `options.metadata` attaches user-defined tags.

```typescript
import { dumpSnapshot } from '@rejelly/core/debugger';

// Export snapshot during Agent execution (auto-retrieves current context)
const snapshot = dumpSnapshot();

// Optional: attach user-defined tags
const taggedSnapshot = dumpSnapshot({ metadata: { reason: 'before migration' } });

// Save snapshot to file or database
await saveSnapshot(snapshot);
```

**Return value (core structure; fields stay aligned with the types exported by `@rejelly/core/debugger`):**

```typescript
interface AgentSnapshot {
  /** Process identifier */
  processId: string;
  /** Snapshot creation timestamp */
  timestamp: number;
  /** Root frame snapshot (contains all sub-agent execution records) */
  root: AgentFrameSnapshot;
  /** Trace provenance and recovery anchor */
  provenance: { traceId: string; spanId?: string; anchor?: 'before' | 'after'; source?: 'dump' | 'restore' };
  /** Snapshot format version */
  version: number;
  /** User-defined tags */
  metadata?: Record<string, unknown>;
}

interface AgentFrameSnapshot {
  /** Call ID */
  callId: string;
  /** Agent ID */
  agentId: string;
  /** Memory state (JSON-serializable) */
  memory: Record<string, unknown>;
  /** Execution journal (for replay interception). prompt/tool keys are contentHash (input hash), decoupled from callId */
  journal: {
    /** LLM call records, key = contentHash */
    prompt: Record<string, JournalEntry>;
    /** Tool call records, key = contentHash */
    tool: Record<string, JournalEntry>;
  };
  /** Sub-agent execution history tree, key = callId */
  children: Record<string, AgentFrameSnapshot>;
  /** Execution status */
  state: {
    /** Status: 'running' | 'completed' | 'failed' */
    status: 'running' | 'completed' | 'failed';
    /** If status === 'completed', stores the return value */
    output?: unknown;
    /** If status === 'failed', stores error info */
    error?: unknown;
  };
  /** Usage for this frame and its descendants */
  budgetState: BudgetState;
}
```

**Call ID and Journal Responsibility Separation:**

- **callId**: Format is `${parentCallId}/${type}:${configId}:${seq}`. `seq` is strictly incremented by the context's `callCounters` on each call (agent / prompt / tool), ensuring multiple calls in the same run (e.g., 3 consecutive `search` calls) get different callIds (e.g., `root/tool:search:0`, `:1`, `:2`). Used for:
  - Topology: `children` keys, parent-child frame relationships
  - Distributed tracing (OpenTelemetry) and DevTool timeline tree view, avoiding Span ID conflicts
- **Journal**: Only responsible for "input → output" caching. The prompt/tool journal is read/written using **contentHash** (input hash) as the key, independent of callId; on replay, the current request's contentHash is looked up in the table, and the cached result is returned on hit. Thus cache logic is decoupled from "which call number."

**How it works:**

1. **Traverse context chain**: Walks up from the current context to the root context, building the complete context chain
2. **Build nested frames**: Creates frame snapshots for each Agent in the context chain, including:
   - Memory state (converts from `ctx.memory` Map to a plain object)
   - Execution journal (copies from `ctx.draft.journal`; prompt/tool keys are contentHash)
   - Sub-agent frames (copies from `ctx.draft.children`, keyed by callId)
   - Execution status (set based on whether currently running)
3. **Handle running state**: If an Agent is still running, it's marked as `status: 'running'`

**Use cases:**

- **Persist execution state**: Save the complete Agent state at a certain point for later restoration
- **Debugging and auditing**: Record the full execution trace, including all sub-agent call history
- **Checkpoint resume**: Periodically save snapshots in long-running Agents, supporting resume after interruption

**Notes:**

- Only callable when the current context's `enableSnapshot` is `true`; otherwise throws `SnapshotDisabledError` (checkable via `isSnapshotDisabledError` from `@rejelly/core`).
- Snapshots only contain JSON-serializable data (memory, journal, etc.)
- Non-serializable data (functions, class instances) are ignored or marked as errors
- Snapshots are deep copies — modifying a snapshot does not affect the original context
- promptAgent's input hash includes prompt, schema, model id, model provider
- Tool caching works via a cache middleware added at the innermost layer of the onion model

---

## `runWith(fn, options?)` and Snapshots

Executes a function in an optionally snapshot-restored context. If `options.snapshot` is provided, the root context is restored from the snapshot before execution; otherwise, normal execution proceeds.

```typescript
import { runWith } from '@rejelly/core';
import { dumpSnapshot } from '@rejelly/core/debugger';

// Normal execution (no snapshot)
const result = await runWith(async () => {
  const agent = createAgent({ ... });
  const result = await agent({ input: 'test' });
  const snapshot = dumpSnapshot(); // note: this API is limited to debug environments
  return result;
});

// Execute with snapshot restoration
const snapshot = await loadSnapshot(); // Load from file or database
const result = await runWith(async () => {
  const agent = createAgent({ ... });
  return await agent({ input: 'test' }); // With snapshot, Agent replays quickly, skipping tool and LLM execution via journal cache
}, { snapshot });
```

**Snapshot-related options:**

```typescript
interface RunWithOptions<P = unknown> {
  /** Inject snapshot for context restoration; if provided, restores root context from snapshot before execution */
  snapshot?: AgentSnapshot;
  /**
   * Whether to enable snapshots (default IS_DEV).
   * When true: records journal, saves child frames, dumpSnapshot is callable.
   * When false: recordJournal / saveChildFrame returns immediately, dumpSnapshot() throws SnapshotDisabledError.
   */
  enableSnapshot?: boolean;
  // ... other options in core docs
}
```

**How it works with a snapshot:**

1. Restores root context from the snapshot's root frame
2. Restores memory state (from `frame.memory` to `ctx.memory`)
3. Sets the snapshot on the context (for replay interception)
4. Executes the function in the restored context
5. Sub-agents automatically restore their own frames from the parent context's `snapshot.children` on invocation

**Replay mechanism:**

When an Agent executes in a restored context:

- **Prompt replay**: If the snapshot contains a matching prompt call record (matched by `contentHash`), returns the cached result directly — no LLM call
- **Tool replay**: If the snapshot contains a matching tool call record (matched by `contentHash`), returns the cached result directly — no tool execution
- **Sub-agent replay**: Sub-agents restore their own frames from the parent context's `snapshot.children` and recursively apply the replay mechanism

**Use cases:**

- **Testing and debugging**: Reproduce specific execution scenarios using saved snapshots
- **Cost optimization**: Use snapshots in development environments to avoid repeated LLM and tool calls
- **Checkpoint resume**: Resume execution from a saved snapshot, continuing unfinished tasks
- **Auditing and compliance**: Reproduce historical execution, verify result consistency

**Snapshot restoration notes:**

- If a `snapshot` is used, it is restored only once at the start of `runWith`.
- The restored context state (memory, replay cache, etc.) persists for the entire `runWith` call.
- Prompt and tool calls in the snapshot are matched by hash value — the cache is hit only when inputs are identical. If inputs change, execution proceeds normally and the snapshot is updated.
- `runWith` only injects the snapshot; sub-agents restore themselves automatically on invocation.
- Sub-agent restoration depends on `snapshot.children[callId]`. The `seq` in `callId` is assigned in the order of actual `SubAgent(...)` calls. When calling the same sub-agent in parallel, ensure sub-agent calls happen during the synchronous construction phase so that both the original run and the replay have consistent ordering:

```typescript
// Recommended: SubAgent(...) starts in the synchronous phase of map, seq assigned stably by items order
const tasks = items.map(item => SubAgent({ text: item.text }));
await Promise.all(tasks);
```

- Avoid inserting `await`, `setTimeout`, or other scheduling-uncertain logic before calling sub-agents. Otherwise, parallel sub-agents with the same `configId` may receive different `seq` values due to varying start times, causing `snapshot.children[callId]` misalignment or misses:

```typescript
// Not recommended: SubAgent(...) happens after await, seq depends on async completion order
const tasks = items.map(async item => {
  const prepared = await prepare(item);
  return SubAgent({ text: prepared.text });
});
await Promise.all(tasks);
```

- If each item needs async preparation, prepare data in parallel first, then synchronously start sub-agents in stable array order:

```typescript
const prepared = await Promise.all(items.map(item => prepare(item)));
const tasks = prepared.map(item => SubAgent({ text: item.text }));
await Promise.all(tasks);
```

- Non-serializable data is marked as errors in the snapshot and skipped during replay.

---

## `restoreSnapshot(trace, options?)`

Restores an AgentSnapshot from a linear array of event traces (TraceEvent[]), enabling time travel. Rebuilds the nested frame structure to restore the complete Agent execution state.

```typescript
import { EVENTS } from '@rejelly/core';
import type { TraceEvent, AgentEndEvent } from '@rejelly/core';
import { restoreSnapshot } from '@rejelly/core/debugger';

// Obtain captured events from Review, an EventBus subscription, or persistent storage
declare const events: TraceEvent[];

// Method 1: Simplest usage — restore to latest state (recommended)
const snapshot = restoreSnapshot(events);

// Method 2: Restore to a specific span's end event
const agentEndEvent = events.find(
  e => e.type === EVENTS.AGENT_END
) as AgentEndEvent | undefined;

if (agentEndEvent) {
  const snapshot = restoreSnapshot(events, {
    spanId: agentEndEvent.trace.spanId,
    anchor: 'after'
  });
  const result = await runWith(async () => {
    return await MyAgent({ input: 'test' });
  }, { snapshot });
}
```

**Function signature:**

```typescript
export function restoreSnapshot(
  trace: TraceEvent[],
  options?: RestoreOptions
): AgentSnapshot;

interface RestoreOptions {
  /**
   * Target span ID, determines the point in time to restore to
   * If not provided, defaults to restoring to the last event of the Trace (latest state)
   */
  spanId?: string;

  /**
   * Restore time anchor
   * - 'before': Restore to before this span started (for retry scenarios)
   *   Snapshot does not include this span's execution records; Agent re-executes after restoration
   * - 'after': Restore to after this span ended (for resume scenarios, default value)
   *   Snapshot includes this span's results and cache; Agent skips actual execution on restoration
   * @default 'after'
   */
  anchor?: 'before' | 'after';
}
```

**How it works:**

The function uses a stack-based state machine to rebuild nested frame hierarchies from the flat event timeline:

1. **Locate truncation point**: Determines which events to include based on the target `spanId` and `anchor` mode
   - If `spanId` is not provided: defaults to the last event of the Trace (latest state)
   - `anchor: 'after'`: Finds the span's end event, includes that event and everything before it
   - `anchor: 'before'`: Finds the span's start event, only includes events before it (excluding the start event)

2. **Replay state**: Processes events chronologically, rebuilding:
   - **Frame structure**: Rebuilds Agent hierarchy via `AGENT_START` / `AGENT_END` events
   - **Memory state**: Restores memory from `GENERATION_END` events
   - **Prompt cache**: Restores LLM call cache from `TURN_END` events (based on `contentHash`)
   - **Tool cache**: Restores tool call cache from `TOOLS_EXECUTE_END` events (based on `contentHash`)

3. **State repair**:
   - Marks frames still running at truncation as `status: 'running'`
   - **Best Effort auto-correction**: If a parent Agent ends with unclosed child Agents still on the stack (zombie child nodes), they are automatically marked as `failed` with error information recorded. This ensures logical consistency of the snapshot data structure (no completed parent containing running children).

**Anchor mode explanation:**

- **`'after'` (default)**: Restore to after the target span ends
  - Snapshot includes the span's execution results and cache entries
  - On restoration, Agent skips actual execution and uses cached results directly
  - Suitable for "resume" scenarios, e.g., continuing from a completed step

- **`'before'`**: Restore to before the target span starts
  - Snapshot does not include any trace of this span's execution
  - On restoration, Agent re-executes from scratch
  - Suitable for "retry" scenarios, e.g., re-executing after a step failed

**Usage examples:**

```typescript
import { runWith, EVENTS } from '@rejelly/core';
import type { TraceEvent, AgentStartEvent, AgentEndEvent } from '@rejelly/core';
import { restoreSnapshot } from '@rejelly/core/debugger';

// Scenario 1: Restore to latest state
async function restoreToLatest(trace: TraceEvent[]) {
  const snapshot = restoreSnapshot(trace);
  return await runWith(async () => await MyAgent({ input: 'test' }), { snapshot });
}

// Scenario 2: Resume execution (skip completed steps)
async function resumeExecution(trace: TraceEvent[]) {
  const stepEndEvent = trace.find(
    e => e.type === EVENTS.AGENT_END && e.trace.spanId === 'step_123'
  ) as AgentEndEvent;
  const snapshot = restoreSnapshot(trace, {
    spanId: stepEndEvent.trace.spanId,
    anchor: 'after'
  });
  return await runWith(async () => await MyAgent({ input: 'test' }), { snapshot });
}

// Scenario 3: Retry execution (re-execute failed steps)
async function retryExecution(trace: TraceEvent[]) {
  const stepStartEvent = trace.find(
    e => e.type === EVENTS.AGENT_START && e.trace.spanId === 'step_123'
  ) as AgentStartEvent;
  const snapshot = restoreSnapshot(trace, {
    spanId: stepStartEvent.trace.spanId,
    anchor: 'before'
  });
  return await runWith(async () => await MyAgent({ input: 'test' }), { snapshot });
}
```

**Differences from `dumpSnapshot()`:**

- **`dumpSnapshot()`**: Exports a snapshot directly from the currently running Agent context. Requires the Agent to be executing and the current context's `enableSnapshot` to be `true`.
- **`restoreSnapshot()`**: Restores a snapshot from historical event traces. Does not require the Agent to be executing and does not depend on `enableSnapshot`. Can restore from any point in time. Even in **production** with snapshots disabled, if event traces were collected during runtime, you can use `restoreSnapshot(trace.events)` afterward to rebuild a Snapshot for replay, auditing, or issue reproduction.

**Relationship with `runWith()`:**

- `restoreSnapshot()` generates a snapshot; `runWith()` uses the snapshot to restore execution
- Together they provide full time-travel functionality: restore a snapshot from event traces, then use the snapshot to resume execution

**Error handling:**

The function throws errors in these cases:

- Trace is empty
- Target `spanId` does not exist in the event trace (when `spanId` is provided)
- `anchor: 'before'` and the target span is at the beginning of the trace (cannot go further back)
- Unable to create a root Agent frame (typically when `anchor: 'before'` and the target is the root Agent)

**Notes:**

- **Default behavior**: If `spanId` is not provided, automatically restores to the last event in the Trace
- Event traces are automatically sorted by timestamp to ensure chronological processing
- Prompt and tool cache in the restored snapshot is matched by `contentHash`, ensuring identical inputs produce cache hits
- Non-serializable data (functions, class instances) is not saved in event traces and will be lost on restoration
- The restored snapshot can be used like one generated by `dumpSnapshot()`, passed to `runWith()` for execution restoration
