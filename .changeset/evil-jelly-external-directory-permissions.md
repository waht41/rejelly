---
"@rejelly/evil-jelly": patch
---

Add once, live-session, and project-always external directory permissions. Persist project grants in user JSONC settings, unify external write and delete approval, and prevent cross-session grant leakage and linked-path escapes. Recursive directory deletions retain separate confirmation.

Require one-off human diff confirmation for creating, editing, or deleting user settings, regardless of Auto mode or reusable write grants. Keep other user-global state protected and reject settings writes in non-interactive hosts.
