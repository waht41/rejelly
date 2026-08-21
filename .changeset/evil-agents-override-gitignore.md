---
"@rejelly/evil-jelly": patch
---

Allow reading workspace rule files (AGENTS.md / AGENTS.override.md) even when the root `.gitignore` hides them. Ignoring AGENTS.override.md while keeping it tracked is a Codex convention, so the gitignore guard is relaxed only for rule files; system-hidden entries, sensitive file patterns, and the remaining policy checks still apply.
