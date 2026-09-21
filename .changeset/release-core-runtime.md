---
"@rejelly/core": patch
---

### Core runtime

- Scope cancellation to the active conversation, agent, turn, or tool operation so interrupting in-flight work does not discard unrelated conversation state or newly submitted user input. ([#83](https://github.com/waht41/rejelly/pull/83))
- Track equipped resource presence by key so dependency changes correctly unregister and destroy resources whose values are falsy. ([#84](https://github.com/waht41/rejelly/pull/84))
- Classify model connection failures and request timeouts consistently, including common OpenAI SDK, Node.js, and Undici transport errors. ([#89](https://github.com/waht41/rejelly/pull/89))
