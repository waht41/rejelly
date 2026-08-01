---
"@rejelly/evil-jelly": patch
---

Deduplicate unchanged `read_file` envelopes while their original result remains in live context, refuse lines above 32 KB, and cap every grep result line at 4 KB so minified bundles and pathological logs cannot dominate the model window.
