---
"@rejelly/evil-jelly": patch
---

Fix manual compression after a recoverable model failure by summarizing the pending request's latest context and rebasing its retry snapshot on the compacted history. New input and `/continue` no longer restore discarded history, while failed or interrupted compression preserves the original retry context.
