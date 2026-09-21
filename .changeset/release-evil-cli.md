---
"@rejelly/evil-jelly": patch
---

### CLI behavior

- Fail fast on unknown, cross-command, and missing-value CLI arguments by scoping options to their owning commands and running CAC structural validation before command-specific parsing. ([#102](https://github.com/waht41/rejelly/pull/102))
