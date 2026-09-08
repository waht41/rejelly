# @rejelly/adapter-openai

## 0.2.0

### Minor Changes

- 574d513: ### OpenAI adapter
  
  - Ignore Rejelly-owned metadata when merging same-role messages while preserving provider metadata boundaries for strict chat templates. ([#16](https://github.com/waht41/rejelly/pull/16))
  - Make adapter compliance matrices explicitly environment-driven without fallback models or endpoints. ([#42](https://github.com/waht41/rejelly/pull/42))
  - Add OpenAI Responses API support with stateless output-item replay, reasoning summaries, function calls, schema mode, normalized usage, and protocol-compatible native state restoration. ([#76](https://github.com/waht41/rejelly/pull/76))

### Patch Changes

- Updated dependencies [574d513]
  - @rejelly/core@0.2.0

## 0.1.0

Initial public release.
