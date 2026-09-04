---
"@rejelly/evil-jelly": patch
---

Prevent transient model failures from multiplying across nested retry layers. Evil Jelly now owns the retry budget, disables retries inside the OpenAI SDK, and adds bounded positive jitter to exponential backoff while continuing to honor `Retry-After`.
