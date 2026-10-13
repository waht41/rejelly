---
"@rejelly/adapter-openai": patch
---

Add an explicit object root type to tool parameter schemas whose union branches are all objects, preventing rejection by OpenAI-compatible endpoints such as DeepSeek. Apply the same conversion to Chat Completions and Responses while preserving union branches, nested constraints, and schemas with non-object alternatives.
