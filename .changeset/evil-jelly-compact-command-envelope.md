---
"@rejelly/evil-jelly": patch
---

Simplify run_command result envelopes by omitting platform, shell, the default preview label, and false truncation or wrapping flags. Report capture-byte statistics only when capture discards output, while retaining explicit status, exit code, failure reasons, and saved snapshot metadata.
