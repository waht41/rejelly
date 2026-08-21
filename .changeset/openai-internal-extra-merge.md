---
"@rejelly/adapter-openai": patch
---

Ignore Rejelly-owned message metadata when merging consecutive same-role messages for OpenAI-compatible wire formats. Provider metadata still preserves message boundaries, while internal instruction and compaction markers no longer prevent compatibility merging for strict chat templates.

Make OpenAI adapter matrix tests explicitly environment-driven: multiple model profiles can run in parallel, each profile supplies its provider, model, API key, and base URL through an `OPENAI_TEST_*` or `DEEPSEEK_TEST_*` environment-variable prefix. Profiles without complete configuration are not run, and no fallback model or endpoint is used.
