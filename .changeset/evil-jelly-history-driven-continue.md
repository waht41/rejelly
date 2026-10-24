---
"@rejelly/evil-jelly": patch
---

Decide whether `/continue` needs a hidden user prompt from the committed conversation history instead of the previous interruption reason. Reuse pending user messages and normal tool results without extra prompts, warn once about interrupted or unknown tool outcomes, and keep UI-only interruption replies out of model context so interrupted continuations and failed retries do not accumulate hidden prompts.
