# @rejelly/evil-jelly

## 0.2.0

### Minor Changes

- ### Model and agent runtime
  
  - Give Evil Jelly an explicit identity and built-in CLI capability discovery. ([#1](https://github.com/waht41/rejelly/pull/1))
  - Replace Bing scraping with opt-in provider-backed web search while retaining direct webpage reads. ([#4](https://github.com/waht41/rejelly/pull/4))
  - Forward configurable reasoning effort to OpenAI-compatible providers. ([#26](https://github.com/waht41/rejelly/pull/26))
  - Add OpenAI Responses-compatible web search, OpenRouter source handling, proxy routing, and provider-reported usage accounting. ([#65](https://github.com/waht41/rejelly/pull/65))
  - Prevent nested retry layers from amplifying transient model failures, and add bounded jitter while honoring `Retry-After`. ([#72](https://github.com/waht41/rejelly/pull/72))
  - Show progress while tool-call arguments stream, including tool names, accumulated size, and long-running elapsed time. ([#74](https://github.com/waht41/rejelly/pull/74))
  - Add explicit Chat Completions or Responses protocol selection, persisted native provider state, detailed token budgets, protocol status, and bounded request setup. ([#77](https://github.com/waht41/rejelly/pull/77))
  - Keep the composer and safe local commands available during active turns while queueing model steers and rejecting unsafe concurrent session commands. ([#78](https://github.com/waht41/rejelly/pull/78))
- ### Sessions, prompts, and context
  
  - Keep workspace instructions and compaction payloads directly copyable inside stable XML-like boundaries. ([#17](https://github.com/waht41/rejelly/pull/17))
  - Resume compacted sessions without exposing internal bridge messages, and preserve structured attachment summaries in user-facing transcripts. ([#19](https://github.com/waht41/rejelly/pull/19))
  - Bound retained compaction context, scale retention to model windows, replace file bodies with references, and retain recent images according to estimated cost. ([#21](https://github.com/waht41/rejelly/pull/21))
  - Store sessions in append-only JSONL logs with single-writer protection, interrupted-turn recovery, content-addressed image blobs, and conservative legacy migration. ([#23](https://github.com/waht41/rejelly/pull/23))
  - Replace display-text placeholders with a semantic prompt document and persist rich input as a frozen canonical Session V3 record with durable image resources and conservative V1/V2 migration. ([#36](https://github.com/waht41/rejelly/pull/36))
  - Assign stable session-level ordinals to pasted images across turns and resumed sessions. ([#48](https://github.com/waht41/rejelly/pull/48))
  - Anchor automatic compaction to provider-reported prompt usage and restore validated token anchors during resume. ([#62](https://github.com/waht41/rejelly/pull/62))
- ### Skills, memory, MCP, and configuration
  
  - Add layered user and workspace settings with CLI precedence, strict parse failures, and a tracked workspace template. ([#33](https://github.com/waht41/rejelly/pull/33))
  - Add configurable MCP servers with lifecycle modes, progressive tool discovery, policy-gated calls, approvals, auditing, and an interactive manager. ([#40](https://github.com/waht41/rejelly/pull/40))
  - Add proposal-based persistent memory with user and project scopes, confirmation, catalog and detail reads, provenance, and interactive management commands. ([#43](https://github.com/waht41/rejelly/pull/43))
  - Keep memory confirmation previews bounded and scrollable, with explicit saved or rejected outcomes. ([#45](https://github.com/waht41/rejelly/pull/45))
  - Add `--env` selection for switching provider identities, then extend it with isolated named or path-based profiles that do not mix env files. ([#27](https://github.com/waht41/rejelly/pull/27), [#46](https://github.com/waht41/rejelly/pull/46))
  - Add `/skills` list, show, and diagnose workflows, detailed inspection, absolute paths, and folder-opening commands. ([#49](https://github.com/waht41/rejelly/pull/49))
  - Distinguish a home-directory workspace from user configuration while preserving independent project memories and safe legacy migration. ([#57](https://github.com/waht41/rejelly/pull/57))
  - Wrap long memory detail fields into scrollable visual lines instead of truncating them. ([#58](https://github.com/waht41/rejelly/pull/58))
  - Add local Skills with tokenized prompt references, then extend them with process-lifetime user and project roots, portable `.agents/skills` discovery, layered enablement, bounded tools, and explicit interactive selection. ([#34](https://github.com/waht41/rejelly/pull/34), [#66](https://github.com/waht41/rejelly/pull/66))
- ### Terminal and interactive experience
  
  - Improve Markdown rendering with distinct heading levels, correct ordered-list numbering, standards-based mdast/GFM parsing, single-pass inline rendering, and context-preserving emphasis and links. ([#7](https://github.com/waht41/rejelly/pull/7), [#8](https://github.com/waht41/rejelly/pull/8), [#9](https://github.com/waht41/rejelly/pull/9), [#15](https://github.com/waht41/rejelly/pull/15))
  - Keep the prompt caret correctly positioned across soft-wrapped rows. ([#11](https://github.com/waht41/rejelly/pull/11))
  - Show live command output in a shared transient tail window with stable invocation numbering and compact scrollback. ([#12](https://github.com/waht41/rejelly/pull/12))
  - Keep historical tool blocks within terminal width while retaining full output through expansion. ([#13](https://github.com/waht41/rejelly/pull/13))
  - Preserve semantic inline placeholders through prompt display and editing. ([#14](https://github.com/waht41/rejelly/pull/14))
  - Show runtime phase and elapsed turn time in a persistent status line so slow or stalled work remains visible and interruptible. ([#25](https://github.com/waht41/rejelly/pull/25))
  - Commit streamed text before system notices instead of swallowing the assistant's pre-tool tail. ([#28](https://github.com/waht41/rejelly/pull/28))
  - Group parallel tool batches in scrollback with invocation-order-aware headers. ([#29](https://github.com/waht41/rejelly/pull/29))
  - Add language-aware CJK and Latin wrapping while preserving ANSI styles, hyperlinks, punctuation, measurement, and caret offsets. ([#31](https://github.com/waht41/rejelly/pull/31))
  - Add opt-in startup profiling and reduce interactive startup latency through deferred and bundled dependency loading. ([#54](https://github.com/waht41/rejelly/pull/54))
  - Refresh terminal presentation with richer Markdown, lazy syntax highlighting, compact unified diffs, and resumable successful tool observations. ([#56](https://github.com/waht41/rejelly/pull/56))
  - Make Escape dismiss active composer pickers before clearing the draft. ([#69](https://github.com/waht41/rejelly/pull/69))
  - Keep expanded tool transcript selection stable as newer calls complete. ([#71](https://github.com/waht41/rejelly/pull/71))
- ### Workspace and command tools
  
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

### Patch Changes

- ### Architecture
  
  - Reorganize Evil Jelly around explicit domains, user-facing features, and cohesive CLI capabilities, tighten the dependency graph, and preserve tool-call numbering during resume. ([#35](https://github.com/waht41/rejelly/pull/35))
- Updated dependencies:
  - @rejelly/core@0.2.0
  - @rejelly/adapter-mcp@0.2.0
  - @rejelly/adapter-openai@0.2.0

## 0.1.0

Initial public release.
