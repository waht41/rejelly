---
"@rejelly/evil-jelly": minor
---

Add `OPENAI_REASONING_EFFORT`, forwarded to the provider as `reasoning_effort` on every chat completion. Reasoning models expose a thinking budget and there was no way to set one — the adapter was built from four fields and never passed any completion params — so requests always ran at the provider default, `high` on DeepSeek V4, leaving the `max` level it recommends for agent workloads reachable only by editing the source.

The value is forwarded verbatim because the vocabulary is the provider's (`max` is DeepSeek's, `minimal` is OpenAI's) and the SDK's own union covers neither fully. Unset sends nothing, so existing configurations are unaffected. DeepSeek-shaped configurations additionally get the `thinking` switch, which `none` sets to `disabled`.
