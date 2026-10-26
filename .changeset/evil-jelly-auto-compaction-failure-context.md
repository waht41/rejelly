---
"@rejelly/evil-jelly": patch
---

Preserve the latest committed model context on every model-error exit so automatic compaction is not lost when a later request fails. New tasks and continuations retain the checkpoint and completed work without including unfinished streamed output.
