# Debug (Debugging & Observability)

The Debugger module provides logging and observability tools to help developers debug and monitor Agent execution.

## Module Overview

The Debugger module includes two categories of debugging and observability integrations:

1. **OTLP Exporter**: Sends trace events to OTLP-compatible servers (e.g., Jaeger, Zipkin, Tempo)
2. **Review Exporter**: Sends trace events in real time to the Rejelly Review Server for visual debugging

Both capabilities are built on the framework's EventBus mechanism, recording or exporting Agent execution traces by subscribing to events.

`withCustomSpan` is the manual instrumentation API: it creates child spans during Agent execution and produces `custom:span:start` / `custom:span:end` events, consumed uniformly by the OTLP Exporter and Review Exporter.

## Custom Span

### `withCustomSpan(name, fn, options?)`

Manually creates a tracing span to mark business steps, external calls, batch processing phases, and other execution segments that the framework cannot automatically identify. It must be called within an Agent runtime context; throws `RequiresAgentContextError` if no current AgentContext exists.

- `name`: Span name
- `fn`: Async function to execute under this span, receives `span` parameter
- `options.attributes`: Static attributes written when the span starts
- `span.setAttribute(key, value)`: Append a single attribute during execution
- `span.setAttributes(attributes)`: Append multiple attributes during execution

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

OTLP exporter sends trace events to OTLP-compatible servers (e.g., Jaeger, Zipkin, Tempo, Grafana Cloud, etc.). Uses HTTP/JSON format — no protobuf dependency required.

**Basic usage:**

```typescript
import { enableOTLP } from '@rejelly/core/debugger';

// Enable OTLP traces export
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-app',
});

await MyAgent({ topic: 'test' });

// Disable and flush remaining events
await disable();
```

**Configuration options:**

```typescript
interface OTLPOptions {
  /** OTLP endpoint URL (e.g., 'http://localhost:4318/v1/traces') */
  endpoint: string;
  /** Custom event bus (optional, defaults to global bus) */
  eventBus?: EventBus;
  /** Service name (default: 'rejelly') */
  serviceName?: string;
  /** Additional resource attributes */
  resourceAttributes?: Record<string, string>;
  /** Custom headers for HTTP requests */
  headers?: Record<string, string>;
  /** Event filter (optional) */
  filter?: (event: TraceEvent) => boolean;
  /** Transform events at the export boundary; runs after filter, before OTLP conversion */
  convert?: TraceEventConverter;
  /** Batch size before sending (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Max memory queue length — discards oldest events beyond this (default: 5000) */
  maxQueueSize?: number;
  /** Max retries for retryable HTTP failures (default: 3) */
  maxRetries?: number;
  /** Lifecycle hooks, see "Process Exit Handling" below */
  registerShutdown?: ExporterRegisterShutdown | false;
}
```

**Examples:**

```typescript
// Basic config
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-app',
});

// Full config
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

// Using a custom event bus
const customEventBus = createEventBus();
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  eventBus: customEventBus,
});

// Redact or transform events before export
const disable = enableOTLP({
  endpoint: 'http://localhost:4318/v1/traces',
  convert: (event) => ({
    ...event,
    props: event.props ? redactSecrets(event.props) : event.props,
  }),
});
```

**Event conversion rules:**

- **Span events**: `:start` events are ignored by default; lifecycle `:end` events are converted to OTLP Spans
- **Instant events**: Trace-local events without a `duration` field are folded into their parent Span's OTLP Span Events — zero-duration Spans are not exported
- **Error handling**: Error information is converted to OTLP exception events, including `exception.type`, `exception.message`, and `exception.stacktrace`

**Batch sending mechanism:**

- Events are cached in memory
- When the cache reaches `batchSize`, the batch is sent automatically
- Auto-flushes every `flushInterval` ms
- Only one send task is allowed at a time; no new HTTP requests are initiated concurrently during retries
- When the queue reaches `maxQueueSize`, the oldest events are dropped — newest observations are prioritized
- Calling `disable()` flushes all remaining events

**Process exit handling:**

- By default listens for `SIGINT`, `SIGTERM`, and `beforeExit` via `registerNodeShutdown()`
- Tries to flush remaining events before exit; forced-exit timeout during flush is controlled by `registerNodeShutdown`'s `shutdownTimeout` (default 3000ms). For custom timing, pass `registerShutdown: registerNodeShutdown({ shutdownTimeout: 5000 })`
- To flush on `uncaughtException` / `unhandledRejection`, pass `registerShutdown: registerNodeShutdown({ catchGlobalErrors: true })` (may conflict with Sentry, etc.)

**Supported OTLP servers:**

- Jaeger
- Zipkin
- Tempo
- Grafana Cloud
- Any server compatible with OTLP HTTP/JSON format

**Notes:**

- Only lifecycle `:end` events are exported as Spans; instant events are attached as Span Events to the target Span; `:start` events are ignored
- Uses HTTP/JSON format — no protobuf dependency required
- Trace IDs and Span IDs are automatically normalized to 32-hex-character and 16-hex-character strings
- If the parent Span ID does not exist, the `parentSpanId` field is omitted (some servers require this)

## Review Exporter

Review exporter sends trace events in real time to the Rejelly Review Server. Supports both `:start` and `:end` events for real-time visual tracing. Uses the raw event format (no OTLP conversion).

**Basic usage:**

```typescript
import { enableReview } from '@rejelly/core/debugger';

// Enable Review export
const disable = enableReview({
  endpoint: 'http://localhost:5789/api/v1/traces',
});

await MyAgent({ topic: 'test' });

// Disable and flush remaining events
await disable();
```

**Configuration options:**

```typescript
import type { TraceEvent } from '@rejelly/core';

interface ReviewOptions {
  /** Review server endpoint URL (default: REJELLY_REVIEW_ENDPOINT or 'http://localhost:5789/api/v1/traces') */
  endpoint?: string;
  /** Custom event bus (optional, defaults to global bus) */
  eventBus?: EventBus;
  /** Custom HTTP headers (e.g., pass API Key via `Authorization`) */
  headers?: Record<string, string>;
  /** Event filter (optional) */
  filter?: (event: TraceEvent) => boolean;
  /** Batch size before sending (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Max memory queue length — discards oldest events beyond this (default: 5000) */
  maxQueueSize?: number;
  /** Max retries for retryable HTTP failures (default: 3) */
  maxRetries?: number;
  /** Lifecycle hooks, see "Process Exit Handling" below */
  registerShutdown?: ExporterRegisterShutdown | false;
}
```

**Examples:**

```typescript
// Basic config
const disable = enableReview({
  endpoint: 'http://localhost:5789/api/v1/traces',
});

// Using a custom event bus
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

**Real-time mode features:**

- **Supports Start events**: Unlike the OTLP Exporter, Review Exporter supports `:start` events for true real-time tracing
- **Raw event format**: Sends events in raw format — no OTLP conversion
- **Real-time visualization**: Default batch size is 10, flush interval is 5 seconds; adjust `batchSize` and `flushInterval` for lower latency

**Batch sending mechanism:**

- Events are cached in memory
- When the cache reaches `batchSize`, the batch is sent automatically
- Auto-flushes every `flushInterval` ms
- Only one send task is allowed at a time; no new HTTP requests are initiated concurrently during retries
- When the queue reaches `maxQueueSize`, the oldest events are dropped — newest observations are prioritized
- Calling `disable()` flushes all remaining events

**Process exit handling:**

- By default listens for `SIGINT`, `SIGTERM`, and `beforeExit` via `registerNodeShutdown()`
- Tries to flush remaining events before exit; forced-exit timeout during flush is controlled by `registerNodeShutdown`'s `shutdownTimeout` (default 3000ms). For custom timing, pass `registerShutdown: registerNodeShutdown({ shutdownTimeout: 5000 })`
- To flush on `uncaughtException` / `unhandledRejection`, pass `registerShutdown: registerNodeShutdown({ catchGlobalErrors: true })` (may conflict with Sentry, etc.)

**Notes:**

- Supports `:start` and `:end` events for real-time visualization
- Uses raw event format — no OTLP conversion
- Adjust `batchSize` and `flushInterval` to tune real-time responsiveness vs. request frequency
- Errors are logged to console and do not throw (to avoid affecting the main flow)
