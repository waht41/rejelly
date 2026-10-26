---
"@rejelly/evil-jelly": patch
---

Remove withdrawn inputs from the live terminal display as well as the transcript. Keep fresh inputs and their following output in a bounded, refreshable region until user-visible assistant output starts, committed tool progress occurs, or the turn closes, so withdrawing an input does not erase earlier scrollback or suppress subsequent answers. Once a reply starts streaming, retain the user input in static history and incrementally release stable Markdown rather than holding the entire answer in the retractable viewport. Restore the original withdrawn input, including semantic tokens and attachments, by prepending it to the current composer draft with a newline separator. Preserve newly typed content, restored queued inputs, and attachments from both sides.
