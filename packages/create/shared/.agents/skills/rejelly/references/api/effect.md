# Effect

Handles process display only — it does not intervene in control flow.

## `onStream(consumer, options?)`

Listens to Agent-level stream events within the current Generation for real-time display of model output, structured data parsing progress, tool call processes, token usage, etc.

Must be registered **before** `promptAgent()` / `promptChat()` within the same Generation; calling `onStream()` afterwards throws `AfterPromptAgentError` (exported by `@rejelly/core`).

```typescript
onStream(
  async (stream) => {
    for await (const event of stream) {
      if (event.type === 'structured_data') {
        // event.status: 'partial' | 'complete' | 'error'
        // event.data: currently parseable structured data
        // event.isValid: whether current data passes lightweight schema check
        updateUI(event.data);
      }

      if (event.type === 'text') {
        // Raw text delta; for typewriter effects or fallback display
        appendRawText(event.delta);
      }

      if (event.type === 'tool_call') {
        showToolCall(event.toolCall);
      }
    }
  },
  { awaitOnEnd: true },
);

const result = await promptAgent(ResponseSchema);
```

### Common Events

| Event | Description |
|-------|-------------|
| `turn_start` | An LLM turn begins |
| `text` | Model text delta, field is `delta` |
| `reasoning` | Reasoning/thinking delta, field is `delta` |
| `structured_data` | Structured data parsed from the current text buffer |
| `tool_call_stream` | Streaming chunks of tool call parameters; one call streams many chunks sharing a `chunk.index` |
| `tool_call` | Tool call fully assembled; emitted before `turn_done` and before the tools run |
| `usage` | Token usage |
| `extra` | Extra metadata returned by the adapter/model |
| `turn_done` | Final event of the turn, with the adapter's `finishReason` (`unknown` if omitted); tools have not started yet |
| `error` | An error occurred during streaming |

The engine retains the adapter's `finishReason`, drains the adapter stream, emits the final `structured_data` snapshot when applicable and one `tool_call` per assembled call, then emits `turn_done`. It is therefore safe to summarize the turn there. See [`onStream` in the Core API](./core.md#onstream-consumer-options) for the full ordering.

The Generation stream has no separate end event: the `for await...of` loop ending is the signal. It ends normally on close, cancellation, and after producer failures (which arrive as `error` events). A consumer can still throw from its own code, so use `finally` for cleanup that must always run.

### `structured_data`

`structured_data` is the most commonly used event for structured output UIs:

Without a schema, it is emitted only when the accumulated text is successfully recognized as a JSON object. Ordinary prose does not emit invalid snapshots or a final parse error.

```typescript
onStream(
  async (stream) => {
    for await (const event of stream) {
      if (event.type !== 'structured_data') continue;

      if (event.status === 'partial' && event.isValid) {
        renderPartial(event.data);
      }

      if (event.status === 'complete') {
        renderFinal(event.data);
      }

      if (event.status === 'error') {
        showFallback();
      }
    }
  },
  { awaitOnEnd: true },
);
```

- `status: 'partial'`：Stream is still in progress; `data` is the currently parseable partial structure.
- `status: 'complete'`：Turn ended and parsing succeeded.
- `status: 'error'`：Turn ended but structured parsing failed.
- `isValid`：Whether the current `data` passes a lightweight schema check; it is not a full Zod validation.

`options.awaitOnEnd` defaults to `true` — before the current generation ends, it waits for the stream consumer to finish processing events and complete its own cleanup (e.g., testing, logging, syncing UI state). Pure UI fire-and-forget consumers can set this to `false`.
