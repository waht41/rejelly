---
"@rejelly/evil-jelly": minor
---

Add opt-in startup profiling through `--profile` and `EVIL_PROFILE`, with a process-relative Gantt view of bootstrap, module imports, Ink rendering, runtime initialization, and input readiness. Add focused bootstrap, import, and Ink drill-down views so startup dependencies, overlap, and critical-path costs can be inspected without raw milestone logs.

Reduce interactive startup latency by mounting the shell while the remaining runtime modules load, bundling expensive Markdown and MCP dependency graphs, lazily loading the HTTP client, and restoring Windows virtual-terminal input asynchronously instead of blocking Ink's first render.
