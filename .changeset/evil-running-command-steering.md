---
"@rejelly/evil-jelly": patch
---

Keep the interactive composer available while an agent turn is running. `/status` requests now appear beside queued steers in a shared pending area, coalesce when repeated, and print at the next safe presentation boundary after the current assistant stream segment or parallel tool batch. They remain local commands and are never delivered to the model. `/skills`, `/memory`, and `/mcp` can still open their managers without waiting for the active tool or model operation to finish.

Continue rejecting session lifecycle commands that cannot safely run concurrently, including `/clear`, `/compress`, and `/resume`. Leading-slash text that does not match a supported command grammar, such as comments, paths, and regex-like input, is now delivered as a normal steer instead of being mistaken for a slash command.
