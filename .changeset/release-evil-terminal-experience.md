---
"@rejelly/evil-jelly": minor
---

### Terminal and interactive experience

- Support Alt+V image attachment from copied image files on Windows, Windows clipboard access from WSL, and native Wayland/X11 clipboards on Linux while preserving image MIME types and temporary-file cleanup. ([#92](https://github.com/waht41/rejelly/pull/92))
- Show in-flight tool calls in `/expand-tool` with their arguments and live output, retain a byte-bounded running transcript, and preserve selection as calls update and complete. ([#94](https://github.com/waht41/rejelly/pull/94))
- Decode Git-style quoted UTF-8 paths when rendering reviewed diffs so Chinese and other non-ASCII filenames remain readable. ([#101](https://github.com/waht41/rejelly/pull/101))
