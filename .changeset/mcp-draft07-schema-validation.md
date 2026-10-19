---
"@rejelly/adapter-mcp": patch
---

Validate MCP tool input schemas that explicitly declare JSON Schema Draft-07 with the matching validator, fixing `invalid_tool_schema` rejections when calling the devtool and other MCP SDK servers. Preserve Draft 2020-12 validation for schemas without a dialect declaration and continue rejecting invalid schemas and arguments.
