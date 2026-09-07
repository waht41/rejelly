---
"@rejelly/evil-jelly": minor
---

Add explicit `OPENAI_API_PROTOCOL` selection with Responses support while keeping Chat Completions as the default. Map reasoning effort per protocol, persist detailed token budgets, expose the active protocol in status output, warn when resumed native state belongs to the other protocol, and bound OpenAI SDK request setup to 30 seconds.
