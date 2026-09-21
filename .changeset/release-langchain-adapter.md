---
"@rejelly/adapter-langchain": minor
---

### LangChain adapter

- Consume async-generator results from duck-typed LangChain tools that expose only `func`, while preserving standard `invoke` handling and documenting that yielded tool events are not bridged to Rejelly stream output. ([#109](https://github.com/waht41/rejelly/pull/109))
