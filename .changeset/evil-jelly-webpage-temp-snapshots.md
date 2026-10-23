---
"@rejelly/evil-jelly": minor
---

Bound read_webpage responses to 32 KiB and save long cleaned pages as complete Markdown reading snapshots under `%TEMP%/evil-jelly/<project-bucket>/<query>-<random>.md`, reusing the exact session workspace-bucket naming logic. Return absolute paths and grep/read_file guidance, distinguish fetch truncation from preview truncation, and wrap pathological snapshot lines without dropping text.

Allow read and scan access to the registered temporary snapshot directory without granting access to the surrounding system temp or bypassing write approvals. Snapshots have per-file, total-byte, count and lifetime limits and are cleaned on normal process exit; crashes may leave files for system cleanup, and historical snapshot paths are not durable.

Stream explicitly selected grep files up to 16 MiB instead of silently skipping them above 200 KiB, while preserving directory-scan limits. Enforce webpage fetch limits at exact UTF-8 byte boundaries.
