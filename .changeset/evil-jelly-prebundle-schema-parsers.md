---
"@rejelly/evil-jelly": patch
---

Prebundle YAML, Zod (including the MCP SDK's v3/v4 compatibility subpaths), and zod-to-json-schema in the CLI to reduce startup module-loading overhead without deferring initialization or changing runtime behavior.
