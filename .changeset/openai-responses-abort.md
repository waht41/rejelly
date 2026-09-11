---
"@rejelly/adapter-openai": patch
---

Normalize cancelled Responses streams to `AbortError` when compatible endpoints close the iterator cleanly or surface endpoint-specific transport failures.
