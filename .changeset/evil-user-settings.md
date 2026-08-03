---
"@rejelly/evil-jelly": minor
---

Add `~/.evil-jelly/settings.jsonc` for non-secret user preferences shared across workspaces. Settings now resolve field by field with CLI overrides first, workspace `.evil-jelly/settings.jsonc` second, user settings third, and built-in defaults last. Missing files remain the normal empty state, while malformed or unreadable files fail loudly.

Keep workspace settings as local-checkout overrides without committing personal values: `.evil-jelly/settings.jsonc` is now ignored, and `.evil-jelly/settings.example.jsonc` provides the tracked template.
