---
"@rejelly/evil-jelly": patch
---

Render terminal Markdown from the inline mdast nodes produced by the initial document parse instead of reparsing extracted block text. This preserves the original Markdown context, fixes leading emphasis such as bold code spans, attachment labels, and underscore emphasis, and removes the sentinel characters previously required to force inline parsing.
