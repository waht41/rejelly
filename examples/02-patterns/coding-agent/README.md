# Coding Agent Pattern

> [中文](README.zh-CN.md) | English

This example demonstrates a **minimal-but-real coding agent**: explore → edit → run → verify in a sandboxed workspace, driven by a single `promptChat` call. There is no plan/act state machine — the tool loop is the framework's, and everything you'd actually customize (tools, policy, prompt) is plain code in this directory.

## Run

From the `examples` root:

```bash
pnpm run start -- --module=coding-agent --example=fix-bug
```

Or pick **Coding Agent** from the menu and choose a scenario:

- `scaffold` — empty workspace: write `fizzbuzz.js`, run it with node, confirm the output.
- `fix-bug` — seeded workspace with a failing test: run it, locate the bug, make a minimal `edit_file` fix, re-run until green.

Each run creates a fresh temp workspace (path printed at start) so the agent can never touch your real files. Mutating tools ask **y/N** in the terminal — answer no once to watch the agent read the denial and adapt.

## Idea

Three pieces, each deliberately small:

1. **Native tools are cheap** (`tools.ts`): the five coding primitives — `list_files`, `read_file`, `write_file`, `edit_file`, `run_command` — are plain `{ name, description, parameters, handler }` objects, a few dozen lines each, bound to a sandbox root by an ordinary factory closure. No registry, no decorators.

2. **Policy is middleware, not tool code** (`approval.ts`): a logger and a human-approval gate, attached per-tool. The read-only/mutating split is one visible line:

```typescript
for (const tool of createCodingTools(props.workspace)) {
  equipTool(tool, {
    middleware: MUTATING_TOOL_NAMES.has(tool.name)
      ? [consoleToolLogger, approvalGate] // logged, then gated
      : [consoleToolLogger],              // read-only runs freely
  });
}
```

A denial *returns* a string instead of throwing, so the refusal becomes a normal tool result the model can read and route around.

3. **The loop is free** (`coding-agent.ts`): after equipping tools, one call runs the whole model-decides → tools-execute → results-feed-back cycle until the model answers in text, bounded by `maxTurnSteps`:

```typescript
const { data: summary } = await promptChat({
  message: { role: "user", content: props.task },
});
```

The system prompt carries the one habit that separates a coding agent from a code generator: **run the code after changing it** — never claim success without having seen the command output.

## Notes

- **Why native tools instead of MCP?** The file tools *could* be replaced by the official `server-filesystem` MCP server (see `01-basics/mcp-integration` for the wiring). They're written natively here because tool ergonomics is the thing being demonstrated — and because `run_command` has no official MCP server and is exactly where the approval gate matters most.
- **Debugging**: run with `--review` and open the devtool to replay the full trace — every tool call, every model turn — when the agent does something surprising.
