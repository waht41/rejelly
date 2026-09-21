---
"@rejelly/evil-jelly": minor
---

### Workspace and command tools

- Make `edit_file` validate requested edits atomically per file, report every invalid block, preserve conflict-free file updates, and support bounded replacements between unique start and end anchors. ([#81](https://github.com/waht41/rejelly/pull/81))
- Render grep results as merged per-file snippets and return compact source-order AST document outlines with export filtering. ([#86](https://github.com/waht41/rejelly/pull/86))
- Allow the `grep` tool's `directory` parameter to accept a concrete file path as a single-file search fallback. ([#93](https://github.com/waht41/rejelly/pull/93))
- Limit individual command-output lines to 16 KiB before applying the total output cap, preserving UTF-8 boundaries and both ends of oversized lines. ([#98](https://github.com/waht41/rejelly/pull/98))
- Consolidate AST workspace tools into `ast_document_symbols`, `ast_workspace_symbols`, and `ast_read_symbol_code`, remove unused heuristic tools, and render compact readable text instead of JSON-escaped payloads. ([#100](https://github.com/waht41/rejelly/pull/100))
- Make `grep` searches literal by default, add an explicit regex mode, validate expressions before backend selection, and report native search failures accurately. ([#104](https://github.com/waht41/rejelly/pull/104))
