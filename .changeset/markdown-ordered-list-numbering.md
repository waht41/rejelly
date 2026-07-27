---
"@rejelly/evil-jelly": patch
---

Fix ordered list numbering in the markdown viewer. Blank-line separated items no longer split a list into single-item blocks that each restart at `1.`, list numbers now follow the markdown source instead of the render index, and nested items keep their level's own count and indentation.
