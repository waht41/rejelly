---
"@rejelly/evil-jelly": patch
---

Commit the streamed text a system notice interrupts instead of discarding it. Text the model writes before calling a tool reaches the screen as the transient stream tail, and the markdown holdback keeps a trailing list or table there until a later block terminates it — which is exactly the shape of "here is what I am about to do" output. Every `[Auto-allowed]` confirmation logged a system row through a path that reset the stream controller and cleared the buffer without committing either, so that reasoning was visible while streaming and gone from the transcript the moment the tool it announced was approved. It now lands in history ahead of the notice, which is also the order it was written in.

The drain is a distinct operation rather than `finalize("")`: with nothing emitted yet — a preamble that is a list from its first character — the empty final content compares as already covering the stream and the remainder would be dropped again.
