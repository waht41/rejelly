---
"@rejelly/evil-jelly": patch
---

Treat `~/.evil-jelly` exclusively as user configuration when Evil starts with the home directory as its workspace. Skills, settings, environment values, and MCP servers are no longer loaded a second time as project state, and project-scoped MCP mutations fail explicitly instead of modifying the user file.

Keep the home directory's persistent memory as a dedicated project with exact-root matching. Repositories below `~` now receive independent project memories, headless runs resolve memory from their bound workspace, and legacy memory registries migrate in place while preserving existing project IDs and memory files.
