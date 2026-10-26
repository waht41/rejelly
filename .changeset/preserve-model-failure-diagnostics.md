---
"@rejelly/adapter-openai": patch
"@rejelly/evil-jelly": patch
---

Preserve original Responses stream failure events in the model error cause chain and classify known upstream error codes instead of reducing them to unknown errors. Persist bounded, credential-redacted model error diagnostics in Session so failed calls remain diagnosable without a Review trace, while keeping raw SDK payloads out of the journal and retaining compatibility with existing sessions.
