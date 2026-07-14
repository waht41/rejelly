# Investigations

> 总览与三类记录的分工见 [`../README.md`](../README.md)。

This directory stores maintainer investigations: diagnosis, evidence, tradeoffs, rejected arguments, and unresolved design questions.

Investigations are not user-facing documentation and are not the same thing as issues. Use them when a topic is too broad or too uncertain to be represented as a single closable work item.

## Naming

`INV-NNNN-short-slug.md`, zero-padded sequential by `createdAt`. The number is a stable, speakable handle uniform with `ISSUE-NNNN` / `DR-NNNN`; the slug stays human-readable and may be reworded. Do not renumber.

## Required Frontmatter

- `title`
- `status`: `active` | `later` | `resolved` | `superseded` | `archived`
- `createdAt`: `YYYY-MM-DD`
- `updatedAt`: `YYYY-MM-DD`
- `type: investigation`

Optional fields:

- `scope`
- `decision`
- `issues`
- `supersededBy`

## Lifecycle

- `active`: evidence and options are still being collected.
- `later`: known investigation topic, intentionally deferred.
- `resolved`: the important conclusions have been extracted into issues, decisions, or docs.
- `superseded`: another investigation or decision replaced this file.
- `archived`: retained only for historical context.

When an investigation resolves, do not delete it by default. Trim repeated scratch work, preserve the evidence and decision path, then link the resulting issue files and decision record.

## Index

> INV-0001 ~ INV-0022 已归档至 `notes/.archived/investigations/`（本地留存，不进公开仓库）。新 investigation 从 **INV-0023** 起，在此手动登记。
