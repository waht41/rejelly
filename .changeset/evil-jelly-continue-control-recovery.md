---
"@rejelly/evil-jelly": patch
---

Separate explicit `/continue` recovery from automatic model retries. Unclassified pre-output failures can be retried at their safe dispatch checkpoint without rerunning completed tools. Interrupted and resumed tasks continue with system recovery context on the original turn instead of recording a synthetic user input or increasing user-turn counts.
