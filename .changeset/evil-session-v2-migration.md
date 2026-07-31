---
"@rejelly/evil-jelly": minor
---

Store interactive sessions in append-only JSONL logs with single-writer protection and interrupted-turn recovery. Keep the complete transcript separate from compacted model context, persist pasted images in a content-addressed blob store, and avoid creating files for untouched new sessions.

Legacy JSON sessions remain visible and migrate to a self-contained V2 log on first resume without overwriting the original file. Corrupt or unreadable sessions and failed migrations now stop resume instead of silently falling back.
