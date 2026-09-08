---
"@rejelly/evil-jelly": minor
---

### Workspace and command tools

- Refresh fuzzy-search candidates for each tool invocation and file-picker session. ([#10](https://github.com/waht41/rejelly/pull/10))
- Return `read_file` content in metadata-rich raw envelopes and preserve canonical file locators across reads, attachments, resume, and compaction. ([#18](https://github.com/waht41/rejelly/pull/18), [#20](https://github.com/waht41/rejelly/pull/20))
- Harden file and grep intake with unchanged-result deduplication, binary and long-line rejection, and bounded output. ([#32](https://github.com/waht41/rejelly/pull/32))
- Allow tracked workspace rule files to be read even when `.gitignore` hides them. ([#41](https://github.com/waht41/rejelly/pull/41))
- Preserve multiline commands, UTF-8 output, and native exit codes through explicit PowerShell execution on Windows. ([#44](https://github.com/waht41/rejelly/pull/44))
- Allow explicitly requested gitignored paths to be read or modified with bounded discovery and sensitive-path, dependency, and symlink protections. ([#47](https://github.com/waht41/rejelly/pull/47))
- Add policy-gated access to absolute paths outside the workspace with scoped host confirmations and least-privilege session grants. ([#59](https://github.com/waht41/rejelly/pull/59))
- Split workspace file access into owner-focused context, scan, controlled I/O, and external-access capabilities. ([#60](https://github.com/waht41/rejelly/pull/60))
- Complete explicitly named ignored paths in the file picker without exposing workspace-wide ignored matches. ([#61](https://github.com/waht41/rejelly/pull/61))
- Make `run_command` timeouts and interruptions deterministic, retain captured output, and clean up abort listeners after completion. ([#68](https://github.com/waht41/rejelly/pull/68), [#70](https://github.com/waht41/rejelly/pull/70))
