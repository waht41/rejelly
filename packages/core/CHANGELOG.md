# @rejelly/core

## 0.2.1

### Patch Changes

- ### Core runtime
  
  - Scope cancellation to the active conversation, agent, turn, or tool operation so interrupting in-flight work does not discard unrelated conversation state or newly submitted user input. ([#83](https://github.com/waht41/rejelly/pull/83))
  - Track equipped resource presence by key so dependency changes correctly unregister and destroy resources whose values are falsy. ([#84](https://github.com/waht41/rejelly/pull/84))
  - Classify model connection failures and request timeouts consistently, including common OpenAI SDK, Node.js, and Undici transport errors. ([#89](https://github.com/waht41/rejelly/pull/89))

## 0.2.0

### Minor Changes

- ### Core runtime
  
  - Make `turn_done` the final per-turn boundary after stream drainage, structured output, assembled tool calls, and usage recording, while clarifying generation error semantics. ([#30](https://github.com/waht41/rejelly/pull/30))
  - Expose provider tool-call identifiers and cache provenance through middleware metadata. ([#55](https://github.com/waht41/rejelly/pull/55))
  - Attribute nested model token usage to LLM-backed tools without double-counting aggregate budgets. ([#63](https://github.com/waht41/rejelly/pull/63))
  - Add JSON-persistable provider state to messages and stream events and preserve it across construction and replay. ([#75](https://github.com/waht41/rejelly/pull/75))
  - Extend the mock model with reasoning chunks for adapter and tool-loop coverage. ([#76](https://github.com/waht41/rejelly/pull/76))

## 0.1.0

Initial public release.
