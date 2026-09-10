---
"@rejelly/core": patch
"@rejelly/adapter-openai": patch
"@rejelly/evil-jelly": patch
---

Classify OpenAI connection and timeout failures explicitly, keep interactive Evil Jelly sessions waiting for network recovery without consuming transient retry attempts, and retain bounded reconnect behavior for audit and headless runs.
