---
"@rejelly/evil-jelly": minor
---

Bound read_webpage responses to 32 KiB and save long cleaned pages as complete Markdown reading snapshots under `%TEMP%/evil-jelly/<project-bucket>/<query>-<random>.md`, reusing the exact session workspace-bucket naming logic. Return absolute paths and grep/read_file guidance, distinguish fetch truncation from preview truncation, and wrap pathological snapshot lines without dropping text.

Treat the current project's temp directory as a workspace with the same read, scan and reviewed-write access rules, without registrations, quotas, TTLs or process-exit cleanup. Other projects and the surrounding system temp retain their existing external-path rules. Keep absolute file locators and protect temp-root boundaries and link/junction escapes.

Stream explicitly selected grep files up to 16 MiB instead of silently skipping them above 200 KiB, while preserving directory-scan limits. Enforce webpage fetch limits at exact UTF-8 byte boundaries.
