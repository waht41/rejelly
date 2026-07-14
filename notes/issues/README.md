# Internal Issues

> 总览与三类记录的分工见 [`../README.md`](../README.md)。

This directory is for maintainer-only issue notes. These files are not standard user-facing documentation.

Issue identity is derived from the stable filename prefix, not from frontmatter.

Use one flat directory:

```text
ISSUE-0001-short-human-slug.md
```

The issue id is `ISSUE-0001`. Do not add an `id` field to frontmatter. The slug can be adjusted for readability, but the `ISSUE-0001` prefix must not change. Areas, status, and other grouping concerns belong in frontmatter metadata, not directories.

Required frontmatter:

- `title`
- `severity`: `critical` | `high` | `medium` | `low`
- `status`: `open` | `in-progress` | `later` | `done` | `wontfix`
- `createdAt`: `YYYY-MM-DD`
- `updatedAt`: `YYYY-MM-DD`

Everything else is optional query metadata.

## Archived

> ISSUE-0001 ~ ISSUE-0021 已归档至 `notes/.archived/issues/`（本地留存，不进公开仓库）。新 issue 从 **ISSUE-0022** 起，在此手动登记。
