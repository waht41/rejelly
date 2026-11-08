---
"@rejelly/evil-jelly": patch
---

Bound run_command's in-memory stdout/stderr capture to a shared 8 MiB head/tail budget. Save results that exceed the model preview after completion in session temp, with explicit capture-loss metadata and readable long-line wrapping. Reuse read_file's XML-like renderer to separate execution and capture attributes from untrusted command bodies, distinguish inline previews from retained snapshots, and label generated truncation markers. Preserve command outcomes when saving fails.
