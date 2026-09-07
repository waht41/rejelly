---
"@rejelly/adapter-openai": minor
"@rejelly/core": patch
---

Add explicit OpenAI Responses API support with stateless output-item replay, streamed text, reasoning summaries, function calls, schema mode, and normalized token usage. Preserve compatible Chat Completions reasoning metadata in provider state and restore it only for matching protocol, endpoint, and provider identities.

Extend the Core mock model with optional reasoning chunks for adapter and tool-loop tests.
