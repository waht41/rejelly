# Router Pattern

> [中文](README.zh-CN.md) | English

This example demonstrates the **Router pattern**: intent recognition + dispatch. You use Zod to force the LLM to output a structured routing decision, then use plain TypeScript `switch`/`if` to call the right sub-agent. No Graph DSL — native control flow.

## Run

From the `examples` root:

```bash
pnpm run start -- --module=router-agent --example=search
```

Or pick **Router** from the menu and choose an example (search, code, chat).

## Idea

1. **Structured routing decision**: `promptAgent` with a Zod schema so the LLM returns `{ route: 'search_expert' | 'code_expert' | 'casual_chat', reason: string }`.
2. **Dispatch with native control flow**: A simple `switch (decision.route)` that calls the corresponding sub-agent.

```typescript
const decision = await promptAgent(z.object({
  route: z.enum(['search_expert', 'code_expert', 'casual_chat']),
  reason: z.string()
}));

switch (decision.route) {
  case 'search_expert':
    return await SearchAgent({ task: props.input });
  case 'code_expert':
    return await CodeAgent({ task: props.input });
  default:
    return await ChatAgent({ message: props.input });
}
```

Sub-agents are minimal: each returns a result with an `agent` label (e.g. `SearchExpert`, `CodeExpert`, `ChatBot`) so you can see in the terminal which expert handled the request.
