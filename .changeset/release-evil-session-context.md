---
"@rejelly/evil-jelly": minor
---

### Sessions, prompts, and context

- Keep workspace instructions and compaction payloads directly copyable inside stable XML-like boundaries. ([#17](https://github.com/waht41/rejelly/pull/17))
- Resume compacted sessions without exposing internal bridge messages, and preserve structured attachment summaries in user-facing transcripts. ([#19](https://github.com/waht41/rejelly/pull/19))
- Bound retained compaction context, scale retention to model windows, replace file bodies with references, and retain recent images according to estimated cost. ([#21](https://github.com/waht41/rejelly/pull/21))
- Store sessions in append-only JSONL logs with single-writer protection, interrupted-turn recovery, content-addressed image blobs, and conservative legacy migration. ([#23](https://github.com/waht41/rejelly/pull/23))
- Replace display-text placeholders with a semantic prompt document and persist rich input as a frozen canonical Session V3 record with durable image resources and conservative V1/V2 migration. ([#36](https://github.com/waht41/rejelly/pull/36))
- Assign stable session-level ordinals to pasted images across turns and resumed sessions. ([#48](https://github.com/waht41/rejelly/pull/48))
- Anchor automatic compaction to provider-reported prompt usage and restore validated token anchors during resume. ([#62](https://github.com/waht41/rejelly/pull/62))
