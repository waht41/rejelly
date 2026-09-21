# @rejelly/adapter-langchain

## 0.2.0

### Minor Changes

- ### LangChain adapter
  
  - Consume async-generator results from duck-typed LangChain tools that expose only `func`, while preserving standard `invoke` handling and documenting that yielded tool events are not bridged to Rejelly stream output. ([#109](https://github.com/waht41/rejelly/pull/109))

### Patch Changes

- Updated dependencies:
  - @rejelly/core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies:
  - @rejelly/core@0.2.0

## 0.1.0

Initial public release.
