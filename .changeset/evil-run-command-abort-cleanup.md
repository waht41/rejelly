---
"@rejelly/evil-jelly": patch
---

Clean up merged abort listeners after `run_command` completes to prevent listener accumulation and `MaxListenersExceededWarning` during long agent runs.
