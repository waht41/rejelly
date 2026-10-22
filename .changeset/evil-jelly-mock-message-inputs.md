---
"@rejelly/evil-jelly": patch
---

Fix `--mock-inputs` to recover current conversation `props.message` text inputs in order, preserving repeated inputs. Report unsupported input formats explicitly instead of silently falling back to manual input, without adding legacy `props.userInput` compatibility or affecting manual `--mock` replay.
