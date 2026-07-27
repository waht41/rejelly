---
"@rejelly/evil-jelly": patch
---

Keep the prompt caret on the character being typed when the input soft-wraps. The line prompt now wraps the buffer itself and places the caret against those physical rows, instead of deriving row/column from logical lines — which pinned the cursor to the far right of the first row once a line grew past the prompt's width, and mispositioned it when attachment rows above the input wrapped.
