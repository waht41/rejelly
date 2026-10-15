---
"@rejelly/devtool": patch
---

Persist the execution Include system and Include results preferences in browser localStorage so copy and file export choices survive refreshes and switching traces. Preserve the existing defaults and fall back safely when stored values are invalid or browser storage is unavailable.
