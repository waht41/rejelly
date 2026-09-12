---
"@rejelly/evil-jelly": minor
---

Limit individual command-output lines to 16 KiB before applying the total output cap, preserving UTF-8 boundaries and both ends of oversized lines so pathological single-line output cannot dominate the agent context.
