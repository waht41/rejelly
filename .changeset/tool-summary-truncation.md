---
"@rejelly/evil-jelly": patch
---

Keep a tool's headline on one row in history. A long `run_command` soft-wrapped across five or six rows, and the `[Auto-allowed]` notice that precedes it repeated the same command at full length, so a single shell call could occupy a dozen rows of scrollback. The headline is now truncated at the terminal width — nothing is lost, since `/expand-tool #N` reprints the full summary and result — and the command or path in an auto-allow notice is capped at the source, where it cannot be confused with `/expand-tool` output that must stay verbatim. A command carrying its own newlines is flattened for the headline; its exact text remains in the tool's arguments. The interactive confirmation prompt still shows the command in full.
