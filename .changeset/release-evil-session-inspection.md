---
"@rejelly/evil-jelly": minor
---

### Sessions and inspection

- Persist completed model and tool call facts with prompt-composition metrics, token usage, transport retries, and owner-reported tool outcomes. ([#87](https://github.com/waht41/rejelly/pull/87))
- Add `evil inspect` for durable session journals with Session and Turn summaries, waterfalls, segment and checkpoint drill-down, and model and tool call details. ([#88](https://github.com/waht41/rejelly/pull/88))
- Add Session- and Turn-level Tool call aggregation, per-Tool drill-down, unused Tool visibility, direct ToolCall inspection, and unified `--tools [selector]` and `--models [selector]` options. ([#95](https://github.com/waht41/rejelly/pull/95))
- Add grep-specific `evil inspect --tools grep` diagnostics with search-output metrics, expansion analysis, truncation visibility, and richer largest-call details. ([#97](https://github.com/waht41/rejelly/pull/97))
- Add Session-global `TCn` addresses to Tool Call inspection and allow `evil inspect --tools` to select calls by address or persisted ToolCall ID. ([#103](https://github.com/waht41/rejelly/pull/103))
- Display the model prompt cache rate in conversation session summaries and refresh the summary after `/compress` changes the active context. ([#110](https://github.com/waht41/rejelly/pull/110))
