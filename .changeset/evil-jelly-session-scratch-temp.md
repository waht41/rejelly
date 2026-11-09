---
"@rejelly/evil-jelly": patch
---

Move agent scratch files out of the repository into the project-owned system-temp workspace, under `sessions/<session-id>/scratch/`. Keep scratch paths stable across conversation turns and durable-session resumes, with isolated identities for ephemeral conversations. Allocate the path without creating a directory; rely on the existing file-write path to create missing parents on first use. Retain existing file and command approval rules without introducing special scratch permissions.

Provide the absolute scratch path in the dynamic Environment instruction instead of hardcoding `.evil-jelly/tmp` in tool descriptions. Distinguish disposable working files from lasting project deliverables. Leave old scratch files, webpage snapshots, command-output handling, and cleanup policies unchanged.
