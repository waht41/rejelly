---
"@rejelly/evil-jelly": patch
---

Save long webpage reading snapshots under `sessions/<session-id>/webpage/`, beside the current conversation's scratch directory, including ephemeral headless conversations. Create the directory only when a page exceeds the inline budget. Preserve existing fetch, preview, file-access, and approval behavior; leave previously saved project-level snapshots untouched.
