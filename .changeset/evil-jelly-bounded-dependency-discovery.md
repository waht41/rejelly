---
"@rejelly/evil-jelly": patch
---

Allow explicit ignored-file directory listings and grep searches across dependency containers and build output without requiring a concrete package path. List directories breadth-first with relative paths and per-call traversal budgets, and bound ignored-file grep by 200 pattern-matching candidate files plus a separate directory-entry budget. Report incomplete scans clearly while preserving sensitive-file filtering, nested Git and agent metadata exclusions, dependency write protection, and safe link handling.
