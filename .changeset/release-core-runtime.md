---
"@rejelly/core": minor
---

### Core runtime

- Make `turn_done` the final per-turn boundary after stream drainage, structured output, assembled tool calls, and usage recording, while clarifying generation error semantics. ([#30](https://github.com/waht41/rejelly/pull/30))
- Expose provider tool-call identifiers and cache provenance through middleware metadata. ([#55](https://github.com/waht41/rejelly/pull/55))
- Attribute nested model token usage to LLM-backed tools without double-counting aggregate budgets. ([#63](https://github.com/waht41/rejelly/pull/63))
- Add JSON-persistable provider state to messages and stream events and preserve it across construction and replay. ([#75](https://github.com/waht41/rejelly/pull/75))
- Extend the mock model with reasoning chunks for adapter and tool-loop coverage. ([#76](https://github.com/waht41/rejelly/pull/76))
