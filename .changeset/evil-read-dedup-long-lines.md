---
"@rejelly/evil-jelly": patch
---

Deduplicate unchanged `read_file` envelopes while their original result remains in live context; reject binary-looking content and lines above 32 KB with structured diagnostics; and cap grep output at 4 KB per line and 100 KB overall so generated bundles and pathological logs cannot dominate the model window.
