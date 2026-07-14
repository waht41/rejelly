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
| `tool_call_stream` | Streaming chunks of tool call parameters |
| `tool_call` | Tool call fully assembled |
| `usage` | Token usage |
| `extra` | Extra metadata returned by the adapter/model |
| `turn_done` | An LLM turn ends |
| `error` | An error occurred during streaming |

### `structured_data`

`structured_data` is the most commonly used event for structured output UIs:

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
