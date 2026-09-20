---
"@rejelly/adapter-langchain": minor
"create-rejelly": patch
---

Consume async-generator results from duck-typed LangChain tools that expose only `func`, while preserving standard LangChain `invoke` handling and documenting that yielded tool events are not bridged to Rejelly stream output.
