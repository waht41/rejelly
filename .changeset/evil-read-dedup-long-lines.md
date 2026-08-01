---
"@rejelly/evil-jelly": patch
---

Deduplicate unchanged `read_file` envelopes while their original result remains in live context, and refuse lines above 32 KB so minified bundles and pathological logs cannot dominate the model window.
