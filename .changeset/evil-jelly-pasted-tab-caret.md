---
"@rejelly/evil-jelly": patch
---

Fix composer caret misalignment after pasting text containing tabs by expanding tabs only in the display projection. Keep rendering, wrapping, navigation, and command suggestions in the same display coordinates while preserving original tabs through paste collapse, expansion, editing, and submission.
