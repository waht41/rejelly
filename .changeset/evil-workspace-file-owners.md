---
"@rejelly/evil-jelly": patch
---

Replace the monolithic `WorkspaceFsPolicy` and its ambiguous intent/boundary request model with owner-focused workspace context, scan policy, controlled file I/O, and agent external-access modules. Consumers now depend directly on the workspace capability they use, while filesystem behavior and safeguards remain unchanged.
