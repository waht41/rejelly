---
"@rejelly/adapter-openai": patch
---

### OpenAI adapter

- Classify model connection failures and request timeouts consistently, including common OpenAI SDK, Node.js, and Undici transport errors. ([#89](https://github.com/waht41/rejelly/pull/89))
- Normalize cancelled Responses streams to `AbortError` when compatible endpoints close the iterator cleanly or surface endpoint-specific transport failures. ([#91](https://github.com/waht41/rejelly/pull/91))
