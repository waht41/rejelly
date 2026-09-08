---
"@rejelly/devtool": patch
---

### Devtool

- Preserve assistant tool calls and matching tool results when rebuilding Ask AI history so conversations continue correctly after completed tool rounds. ([#53](https://github.com/waht41/rejelly/pull/53))
- Display model tokens, token details, provider, and model attribution for LLM-backed tools while preserving nested attribution in SQLite summaries without double-counting totals. ([#64](https://github.com/waht41/rejelly/pull/64))
