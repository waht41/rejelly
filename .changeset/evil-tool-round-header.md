---
"@rejelly/evil-jelly": minor
---

Head the tool blocks a single model call issued together with a `2 parallel calls` rule. Tool blocks are committed when each call finishes, not when it was issued, so a batch and several sequential calls looked identical in scrollback — and since blocks land in completion order, the numbering ran backwards within a batch with nothing to explain why. The header restores the one distinction that mattered: whether the model saw the previous result before issuing the next call.

Only batches of two or more get a header. A single block is trivially its own batch, so heading every call would be noise, and the rule stays unambiguous in both directions: a header covers the blocks that follow it, and a block with no header above it stood alone. The count comes from the tool-call chunk indexes, which are complete when the turn ends — before any tool runs — so nothing has to be revised after the fact, and there is no closing rule, which would require knowing which block is last. Resumed sessions derive the same headers from the assistant message's `tool_calls`, so scrollback groups identically without storing anything new.
