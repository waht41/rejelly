---
"@rejelly/core": patch
---

Make `turn_done` the actual per-turn boundary. The engine now retains the adapter's `finishReason`, fully drains the adapter stream, emits the final structured-data snapshot and assembled tool calls, records usage, and only then emits `turn_done`. Successfully completed adapter streams and replayed turns now always produce this boundary, using `unknown` when no finish reason is available. Consumers can safely summarize the turn there while still running before tool execution.

Schema-less chat no longer emits invalid `structured_data` snapshots for ordinary prose. Successfully recognized JSON objects remain available as structured snapshots, while parse failures are silent unless the caller supplied a schema and therefore requested structured output.

Clarify the Generation stream lifecycle as well: producer failures are delivered as `error` events and the subscription then closes normally. Consumer-side exceptions can still bypass code after the loop, so unconditional cleanup belongs in `finally`.
