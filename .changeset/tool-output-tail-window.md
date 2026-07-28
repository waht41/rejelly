---
"@rejelly/evil-jelly": patch
---

Show live `run_command` output in a transient tail window instead of dumping it into scrollback. Shell output used to be streamed through `printOut`, which routed it into the assistant's text stream — so every command's full output was committed to history, rendered as markdown, and printed a second time alongside its own collapsed tool block. Tool calls are now announced when they start, giving each one a handle used to attribute its live output and to number it in invocation order; parallel calls keep their own numbering, are removed from the live view individually, and share one fixed-height window with a `#N` prefix.
