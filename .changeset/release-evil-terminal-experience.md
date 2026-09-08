---
"@rejelly/evil-jelly": minor
---

### Terminal and interactive experience

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
