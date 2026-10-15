---
"@rejelly/devtool": patch
---

Keep generation details attached when their host arrives after generation events, including across streamed batches. Restore completed execution history that was hidden when generation:start preceded agent:start, and apply the same orphan linking to generations reconstructed from generation:end.
