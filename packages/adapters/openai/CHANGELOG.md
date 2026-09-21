# @rejelly/adapter-openai

## 0.2.1

### Patch Changes

- ### OpenAI adapter
  
  - Classify model connection failures and request timeouts consistently, including common OpenAI SDK, Node.js, and Undici transport errors. ([#89](https://github.com/waht41/rejelly/pull/89))
  - Normalize cancelled Responses streams to `AbortError` when compatible endpoints close the iterator cleanly or surface endpoint-specific transport failures. ([#91](https://github.com/waht41/rejelly/pull/91))
- Updated dependencies:
  - @rejelly/core@0.2.1

## 0.2.0

### Minor Changes

- ### OpenAI adapter
  
  - Ignore Rejelly-owned metadata when merging same-role messages while preserving provider metadata boundaries for strict chat templates. ([#16](https://github.com/waht41/rejelly/pull/16))
  - Make adapter compliance matrices explicitly environment-driven without fallback models or endpoints. ([#42](https://github.com/waht41/rejelly/pull/42))
  - Add OpenAI Responses API support with stateless output-item replay, reasoning summaries, function calls, schema mode, normalized usage, and protocol-compatible native state restoration. ([#76](https://github.com/waht41/rejelly/pull/76))

### Patch Changes

- Updated dependencies:
  - @rejelly/core@0.2.0

## 0.1.0

Initial public release.
