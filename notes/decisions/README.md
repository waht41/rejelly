# Decisions

> 总览与三类记录的分工见 [`../README.md`](../README.md)。

This directory stores **decision records (DR)**: the durable "we decided X, and rejected Y/Z, for these reasons" output of a resolved investigation or design debate.

A decision record is not an investigation and not an issue:

- **Investigation** (`notes/investigations/`) — diagnosis, evidence, tradeoffs, the path to a conclusion. May stay messy.
- **Issue** (`notes/issues/`) — a single closable unit of work and its resolution.
- **Decision record** (here) — the **standing rule/convention** extracted once a decision is final. Stated as a rule ("span-level KV lives on `trace.attributes`"), not as deliberation ("we lean toward…"). One file per coherent decision, even if it landed across several issues.

When to write one: a convention that future contributors must follow and would otherwise relitigate, where the rejected alternatives matter as much as the chosen one. If it is just "we fixed a bug," an issue is enough.

## Naming

`DR-NNNN-short-slug.md`, zero-padded sequential. Do not renumber; supersede instead.

## Required Frontmatter

- `title`
- `status`: `proposed` | `accepted` | `superseded`
- `createdAt`: `YYYY-MM-DD`
- `decidedAt`: `YYYY-MM-DD`
- `type: decision`

Optional fields:

- `areas`
- `sourceInvestigation` — the source investigation it was extracted from (`INV-NNNN-slug`)
- `issues` — issue ids that implemented the decision
- `supersededBy` — DR id, when `status: superseded`

## Lifecycle

- `proposed`: written but not yet ratified.
- `accepted`: the rule is in force; code and notes should conform to it.
- `superseded`: a later DR replaced it. Keep the file, set `supersededBy`, and leave the original reasoning intact for history.

A DR is authoritative for its rule. Issues and investigations should link to it rather than restate the rule, so there is a single source of truth that cannot drift across copies.

## Index

> DR-0001 ~ DR-0009 已归档至 `notes/.archived/decisions/`（本地留存，不进公开仓库）。新 DR 从 **DR-0010** 起，在此手动登记。
