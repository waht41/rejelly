---
"@rejelly/adapter-openai": patch
"@rejelly/evil-jelly": patch
---

Separate model response-header waits from streaming idle timeouts. Evil now allows five minutes for response headers and five minutes between protocol events, so queued reasoning requests are not repeatedly cancelled after 30 seconds. Both OpenAI protocols support an optional stream idle timeout, preserve cancellation and existing retry boundaries, and distinguish header timeouts from stalled streams.
