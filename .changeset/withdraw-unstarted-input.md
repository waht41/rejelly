---
"@rejelly/evil-jelly": patch
---

Treat cancellation of a fresh user submission before committed assistant or tool progress as input withdrawal. Remove withdrawn inputs from active context, transcript, title and turn counts, and do not offer `/continue` for them. Persist an append-only withdrawal marker so restarting a session cannot restore the cancelled request, while preserving normal interruption recovery for tasks with progress and for interrupted continuations or retries.
