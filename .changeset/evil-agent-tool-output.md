---
"@rejelly/evil-jelly": minor
---

Reduce agent-facing workspace tool overhead: report grep hits as per-file snippets, return compact source-order AST outlines with export and re-export filtering, and render symbol lookup/code results as readable text instead of JSON-escaped payloads. Consolidate overlapping AST tools into `ast_document_symbols`, `ast_workspace_symbols`, and `ast_read_symbol_code`, removing the unused raw-symbol and heuristic dependency-tree tools.
