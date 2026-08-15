---
"@rejelly/evil-jelly": patch
---

Replace display-text placeholders and parallel attachment state with a semantic prompt document. Skill, paste, file, and image tokens now keep their identity and order through editing, queueing, steers, and draft restoration; display labels are projections, and clipboard image resources follow the structured input lifecycle instead of regex matches.

Persist submitted rich input in Session V3 as one frozen canonical record. Model messages, resumed context, history display, transcripts, titles, token estimates, and compaction are derived from that record, while images use durable content-addressed blobs and Skill content is injected once inside an explicit XML boundary. Existing V1 and V2 sessions migrate conservatively without inferring tokens from message or display text.

Slash-command palette selections that belong to the application router, including `/exit`, `/status`, `/clear`, `/compress`, and `/resume`, are submitted normally instead of being dropped when the composer-local command handler declines them.
