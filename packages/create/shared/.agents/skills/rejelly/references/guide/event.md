# Event System

Rejelly's event system provides full observability, allowing developers to monitor Agent execution in real time, debug issues, collect metrics, and build visualization tools.

## Overview

The event system follows a publish-subscribe (Pub/Sub) pattern. The framework automatically emits various events during execution, and developers can subscribe to these events to monitor Agent execution status.

### Core Features

- **Automatic Emission**: Events are emitted automatically during framework execution — no manual triggering required
- **Type Safety**: All events have explicit type definitions with full TypeScript support
- **Trace Context**: Every event carries complete tracing context (traceId, spanId, parentSpanId) for distributed tracing
- **Non-Intrusive**: The event system does not affect Agent execution logic — fully decoupled
- **Flexible Subscription**: Supports subscribing to specific event types or all events (using the `'*'` wildcard)

## Event Type Reference

Events cover every phase of Agent execution. The table below is organized by category, showing **when each event fires** and its **key payload** fields. For the exhaustive field list, refer to the type definitions (see [Authoritative Source for Fields](#authoritative-source-for-fields)) — only the most commonly used fields are listed here to avoid drift from the source of truth. Most categories come in Span pairs (`:start` / `:end`); `:end` events universally include `duration`, `success`, and `error` (`ErrorInfo`) on failure — these are not repeated in the table.

| Category | Event | When It Fires | Key Payload (beyond common fields) |
|----------|-------|---------------|------------------------------------|
| RunWith | `runWith:start` / `:end` | Outer execution entry open/close, **all other events occur between these** | start: `props`, whether snapshot/eventBus is used, registered model/provider key |
| Agent Lifecycle | `agent:start` / `:end` | Agent full lifecycle open/close | start: `props`, `middlewares`; end: `result`, `generationCount` |
| | `agent:reborn` | Agent triggers reborn | `generationId` (0-based), `newProps` (if changed) |
| Generation | `generation:start` / `:end` | Each generation (first or after reborn) open/close | start: `generationId` (0-based), `props` (draft empty, memory unchanged); end: assembled `draft` view for DevTool, this generation's `memory`, `endReason` (`'return'` \| `'error'` \| `'reborn'`) |
| PromptAgent | `promptAgent:start` / `:end` | Before `promptAgent()` call / after all tool loop iterations | start: `generationId`, `schema`, `policyId`; end: `totalSteps`, `cache` |
| Turn | `turn:start` / `:end` | Single step open/close | start: `step` (0-based), `messages`, `schema`, `toolConfig`, `messageCount`; end: `resultType` (`'content'` \| `'tool_calls'`), `message`, `contentHash`, `cache` |
| Validation | `validation:success` / `:fail` | Output validation passes / fails (scoped under `promptAgent`) | Shared: `rawText`, `attempt`; success: `data`; fail: partial `data`, `errors` (`ErrorInfo[]`) |
| Model Call | `model:call:start` / `:end` | Model adapter **physical request** open/close | start: `adapterId`, `provider`, `messageCount`, `usedTools`, `middlewares`, `networkAttempt`; end: `rawText` / `reasoning` / `toolCalls`, `ttft`, `usage` (reasoning models may include `details.reasoningTokens`), `costs`, `finishReason` |
| Budget | `budget:update` | When `updateBudgetChain` records LLM/tool usage | `identifiers`, `delta`, `aggregate` |
| Instrument | `instrument:op:start` / `:end` | `instrument()` wrapped dependency methods (Redis / DB / SDK / vector store…) open/close | `name` (category), `operation` (method name); sanitized metadata in `trace.attributes` |
| Resource | `resource:op:start` / `:end` | `equipResource` create / destroy open/close | `operation` (`'create'` \| `'destroy'`), `resourceId`; end: `reused` (an existing instance was reused during create) |
| Tool Execution | `tools:execute:start` / `:end` | Batch of `tool_calls` execution open/close | start: `toolCallsCount`, `toolNames`, `toolMiddlewares`; end: `successCount`, `failureCount`, `toolResults[]` (`callId` / `toolName` / `input` / `output` / `duration` / `success` / `error` / `cache` / `contentHash`) |
| Custom Span | `custom:span:start` / `:end` | Manual span open/close | `name`; attributes in `trace.attributes` (start: static subset, end: merged full set) |
| Error | `error` | An error occurs | `ErrorInfo`: `name`, `message`, `stack?`, `cause?` (error chain), `details?` (custom error class fields) |
| System Log | `sys:log` | Internal Logger bridge, **only emitted when there's an active trace context** (otherwise falls back to `console.warn`) | `level` (`debug` \| `info` \| `warning` \| `error`), `message`, `args`; always includes `trace` context |

> **Rate-limiting does not emit events**: Rate limiting by [`@rejelly/limit-model`](/en/api/limit-model) uses `withLimit` / `withSimpleLimit` with a fast-fail strategy that throws errors directly — no "rate-limit waiting" events are emitted.

### Authoritative Source for Fields

The table above deliberately avoids exhaustive field listings — payload structures evolve, and prose lists decay fastest. For the **complete, current** fields of any event, read the type definitions directly:

- Event type constants: `EVENTS` (exported from `@rejelly/core`)
- Payload types: `packages/core/src/core/domain/event-payload.ts` and `events.ts`

## Event Structure

All events inherit from the base event structure (`BaseTraceEvent`) and include these common fields:

- **`type`**: Event type (e.g. `'agent:start'`), matching constants in `EVENTS`
- **`trace`**: Tracing context (`TraceContext`), containing `traceId`, `spanId`, `parentSpanId`, etc.
- **`timestamp`**: Event timestamp (milliseconds)
- **`agentId`**: Agent ID (optional)

Events that need scoping declare `generationId` on the event body. Different event types also carry their own specific fields — Start events typically carry input parameters, End events carry results, timing (`duration`), success status (`success`), and `ErrorInfo` on failure.

**Error Info (ErrorInfo)**: End events and error-related events uniformly use serializable `ErrorInfo`, containing `name`, `message`, optional `stack`, optional `cause` (error chain), and optional `details` (structured fields from custom error classes, usable by DevTool, etc.). It can be constructed from an `Error` object or directly.

## Execution Hierarchy and Context Isolation

The event system reflects the hierarchical structure of execution:

### Execution Hierarchy

1. **`runWith`**: The outermost execution entry, always at the top of the call stack. All other events fire between `runWith:start` and `runWith:end`.

2. **Agent and Generation**: Executed inside `runWith`, representing the Agent's full lifecycle.

3. **Other Events**: Events like PromptAgent, Turn, Model Call, Validation, etc., fire during Agent execution.

### Context Isolation

Agents create their own child contexts for isolating memory, resources, and tracing scopes. Sub-agents can explicitly read upstream-exposed data via scope/resource.

## Usage

Event publishing and subscription are provided by **`EventBus`** (implementation: `packages/core/src/core/observability/event-bus.ts`). The framework no longer exports top-level `subscribe` / `subscribeOnce` / `subscribeMany` sugar functions — call these on the bus instance directly.

### Subscribing to Events

Get the default bus via `getGlobalEventBus()` and subscribe to a specific type or the wildcard `'*'`:

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

### One-Time Subscription

Use `subscribeOnce` to listen only once — it auto-unsubscribes after firing:

```typescript
import { getGlobalEventBus, EVENTS } from '@rejelly/core';

const bus = getGlobalEventBus();

bus.subscribeOnce(EVENTS.AGENT_END, (event) => {
  console.log('Agent completed:', event.success);
});
```

### Subscribing to Multiple Event Types

Use `subscribeMany` to register for several event types at once:

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

### Custom Event Bus

The default execution path emits events on the global bus. If you need isolation (e.g. a sandbox, or collecting events for a specific `runWith`), call `createEventBus()` to get an independent instance — its API is identical to the global bus. Then inject it via `runWith(..., { eventBus })` so that execution emits only on that bus:

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

## Use Cases

### Logging

The most common use of the event system is execution logging. The framework provides built-in observability exporters:

- **Review Exporter**: Use `enableReview()` to send trace events in real time to the Rejelly Review Server for visual debugging
- **OTLP Exporter**: Use `enableOTLP()` to send trace events to OTLP-compatible servers (Jaeger, Zipkin, Tempo, etc.)

### Performance Monitoring

By subscribing to model call and tool execution events, you can collect performance metrics:

- Monitor the duration of each LLM call
- Track token usage and cost
- Measure tool execution time

### Debugging and Visualization

The event system provides the data foundation for debugging tools:

- **DevTool**: Rejelly DevTool receives events via WebSocket, rendering the execution process in real time
- **Distributed Tracing**: Via the OTLP exporter, events can be converted to standard tracing data
- **Time-Travel Debugging**: Via `restoreSnapshot()`, you can restore execution state from event traces

### Custom Monitoring

Developers can build custom monitoring solutions on top of the event system:

- Real-time alerts: subscribe to error events, trigger notifications
- Cost accounting: aggregate model call events, compute total cost
- Execution analysis: analyze event sequences, identify performance bottlenecks
- Audit logging: record all critical operations for compliance

## Relationship with the Snapshot System

The event system and snapshot system work closely together:

- **Event Tracing**: The event sequence records the complete execution history
- **Snapshot Restoration**: Via `restoreSnapshot()`, snapshots can be rebuilt from event traces for time-travel debugging
- **Replay Mechanism**: Restored snapshots can replay historical execution for testing and debugging

## Best Practices

1. **Subscribe on Demand**: Only subscribe to the event types you need — avoid processing unnecessary events
2. **Unsubscribe Promptly**: Remember to unsubscribe when components unmount or tasks complete to avoid memory leaks
3. **Error Handling**: Errors in event callbacks do not affect Agent execution, but should be handled properly
4. **Performance**: Keep event callbacks lightweight to avoid blocking the event bus
5. **Type Safety**: Use TypeScript type checking to ensure type-safe event handling

## Summary

The event system is the core of Rejelly's observability, providing:

- **Complete Execution Tracing**: Covers all phases of Agent execution
- **Flexible Subscription Mechanism**: Supports multiple subscription patterns
- **Rich Use Cases**: Logging, monitoring, debugging, visualization, and more
- **Snapshot System Integration**: Supports time-travel debugging and state restoration

Through the event system, developers gain deep insight into Agent execution, quickly identify issues, optimize performance, and build powerful debugging and monitoring tools.
