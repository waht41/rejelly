---
"@rejelly/evil-jelly": patch
---

Replace silently cropped pending input with an explicit, width-aware preview that preserves the start of the message, folds long paste blocks, and keeps attachment failures visible. Show one highlighted folding separator, omit blank rows next to the cut, and restore the full original input once assistant or tool progress commits it to history. Keep resumed history, model input, saved session content, and input-withdrawal behavior intact; complete pending input remains readable through the existing Ctrl+T answer browser.
