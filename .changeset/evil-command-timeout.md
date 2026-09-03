---
"@rejelly/evil-jelly": patch
---

Make `run_command` deterministic for non-interactive coding commands: close stdin so prompting processes observe EOF instead of hanging, keep foreground tool calls pending until completion, and terminate the process tree on timeout or user interruption.

Add an optional `timeoutMs` hard timeout with a three-minute default and a thirty-minute maximum. Timed-out commands now report `status=timed_out`, while aborted commands retain their captured output and report `status=aborted`.
