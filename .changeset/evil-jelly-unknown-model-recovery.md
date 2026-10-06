---
"@rejelly/evil-jelly": patch
---

Keep interactive sessions alive after unclassified model-call failures. Close the failed turn, preserve committed conversation and tool context even without session persistence, and allow explicit conservative `/continue` recovery without automatically retrying unknown errors or treating partial streamed output as a completed assistant message. Non-model internal exceptions retain their existing failure handling.
