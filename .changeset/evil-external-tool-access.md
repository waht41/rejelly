---
"@rejelly/evil-jelly": patch
---

Allow filesystem-backed agent tools to use absolute paths outside the current workspace. Non-sensitive direct reads require host confirmation in normal mode and remain automatic in auto mode, while directory scans and writes always require scoped confirmation and reuse least-privilege session grants. Sensitive-path denial, workspace traversal safeguards, and the existing command confirmation for shell working directories remain in place.
