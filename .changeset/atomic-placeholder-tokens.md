---
"@rejelly/evil-jelly": patch
---

Treat the prompt's inline `[Image #N]` and `[Pasted text #N +X lines]` placeholders as single units. They read as one glyph but live in the buffer as ordinary characters, and only backspace-at-the-token's-end handled them as a whole, so arrow keys walked the caret into a placeholder and the next keystroke corrupted it. A corrupted token stops matching its pattern, which meant the pasted body was never expanded and the attached image was never sent — the content disappeared on submit with nothing to signal it. Caret motions now step over a placeholder in one press and snap back out to the nearer edge if they land inside one, while backspace and delete-word-left remove a whole placeholder instead of shearing its tail (Ctrl+Backspace at the end of `[Image #1]` used to take only `#1]`, because word motion stops at the space inside the token).
