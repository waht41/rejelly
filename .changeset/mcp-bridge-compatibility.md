---
"@rejelly/adapter-mcp": patch
"create-rejelly": patch
---

Harden MCP bridge compatibility: stop retrying failed tool calls to guess their signature, preserve dynamic object arguments and structured tool results, detect tool/prompt pagination cursor cycles, and accept paginated SDK prompt lists. Add explicit `callToolStyle: "positional"` support for legacy clients; the SDK object signature remains the default. Support explicitly declared JSON Schema Draft 2019-09 while retaining Draft-07 and default Draft 2020-12 validation.

Synchronize the bundled create-rejelly MCP guidance with the explicit call signature, structured-result preservation, and paginated prompt-list behavior.
