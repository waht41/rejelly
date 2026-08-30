---
"@rejelly/core": patch
---

Expose the provider tool-call identifier and cache provenance through `ToolContext.metadata`, allowing middleware to correlate an execution with the model tool call that produced it. Stop populating the misleading `sessionId` alias from the trace identifier and deprecate both that alias and the open-ended metadata index signature so application-owned session data stays outside the core execution contract.
