---
"@rejelly/evil-jelly": minor
---

### Model and agent runtime

- Give Evil Jelly an explicit identity and built-in CLI capability discovery. ([#1](https://github.com/waht41/rejelly/pull/1))
- Replace Bing scraping with opt-in provider-backed web search while retaining direct webpage reads. ([#4](https://github.com/waht41/rejelly/pull/4))
- Forward configurable reasoning effort to OpenAI-compatible providers. ([#26](https://github.com/waht41/rejelly/pull/26))
- Add OpenAI Responses-compatible web search, OpenRouter source handling, proxy routing, and provider-reported usage accounting. ([#65](https://github.com/waht41/rejelly/pull/65))
- Prevent nested retry layers from amplifying transient model failures, and add bounded jitter while honoring `Retry-After`. ([#72](https://github.com/waht41/rejelly/pull/72))
- Show progress while tool-call arguments stream, including tool names, accumulated size, and long-running elapsed time. ([#74](https://github.com/waht41/rejelly/pull/74))
- Add explicit Chat Completions or Responses protocol selection, persisted native provider state, detailed token budgets, protocol status, and bounded request setup. ([#77](https://github.com/waht41/rejelly/pull/77))
- Keep the composer and safe local commands available during active turns while queueing model steers and rejecting unsafe concurrent session commands. ([#78](https://github.com/waht41/rejelly/pull/78))
