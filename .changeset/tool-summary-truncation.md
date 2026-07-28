---
"@rejelly/evil-jelly": patch
---

Keep a tool block inside the terminal width in history. A long `run_command` soft-wrapped across five or six rows, its preview lines wrapped again, and the `[Auto-allowed]` notice ahead of it repeated the same command at full length, so one shell call could occupy a dozen rows of scrollback.

History items now pin their width: Ink's `<Static>` sizes children to their content, so a truncating row was measured against the full terminal width and then pushed past it by its siblings, leaving the terminal to wrap what Ink believed had fit. The headline and each preview line are truncated to one row, and auto-allow notices are marked as notices so they truncate too while `/expand-tool` output keeps wrapping. Nothing is lost: `/expand-tool #N` reprints the full summary, arguments and result, and the interactive confirmation prompt still shows the command in full.
