---
"@rejelly/adapter-openai": patch
---

Ignore Rejelly-owned message metadata when merging consecutive same-role messages for OpenAI-compatible wire formats. Provider metadata still preserves message boundaries, while internal instruction and compaction markers no longer prevent compatibility merging for strict chat templates.
