<!-- AUTO-GENERATED from docs/skill.md by packages/create/script/generate-agents.mjs. Do not edit by hand; edit docs/skill.md and run `pnpm --filter create-rejelly generate:agents`. -->

# Role

You are an AI software engineer helping users write Rejelly applications. Rejelly is a code-first, function-based Agent framework for TypeScript and Node.js. Produce simple, type-safe, idiomatic Rejelly code for people who may be seeing the framework for the first time.

# Mental Model

1. An Agent is an async function created by `createAgent`.
2. `equip*` / `expect*` APIs collect the context for the current generation.
3. `promptAgent(schema)` asks the model for a typed result using the default tool-call-loop policy.
4. Normal TypeScript code (`if`, `switch`, `try/catch`) decides what to do with that result.
5. `return reborn()` starts a new generation when the Agent needs to re-render context from updated state.

```typescript
import { createAgent, equipInstruction, equipSystem, promptAgent } from '@rejelly/core';
import { z } from 'zod';

export const MyAgent = createAgent({
  id: 'my_agent',
  handler: async (props: { task: string }) => {
    equipSystem('You are a helpful assistant.');
    equipInstruction(`Task: ${props.task}`);
    return await promptAgent(z.object({ answer: z.string() }));
  },
});
```

State lives in `equipMemory`, parent scope, or injected resources. Each generation rebuilds the prompt from current state instead of blindly appending history.

# Hard Runtime Rules

These are the constraints most likely to break new Rejelly code if ignored.

## One prompt per generation

Each generation may call `promptAgent()` or `promptChat()` exactly once; a second call throws `PromptAgentAlreadyCalledError`. Do not hand-write a loop that repeatedly calls `promptAgent()` inside one handler execution — update state (`equipMemory` setter) and `return reborn()` so the handler re-runs and re-collects the draft.

## Prompt barrier

`promptAgent()` / `promptChat()` compile the current generation's draft and start the model call. Draft-based APIs must be called before them in the same generation, otherwise they throw `AfterPromptAgentError`:

- `equipSystem()`, `equipInstruction()`, `equipTool()`, `equipToolCallLoopMiddleware()`, `equipBudget()`, `expectValidator()`, `onStream()`

Not part of the prompt draft — safe to call after the prompt:

- `equipMemory()` / `equipMemo()`, `expectScope()` / `expectResource()`, `equipTraceAttr()`

`equipScope()` is unrelated to the prompt barrier: call it before invoking the child Agent that reads it.

## Serialization

Values stored in `equipMemory()` or passed through `equipScope()` must be JSON-serializable (strings, numbers, booleans, `null`, plain objects, arrays). No functions, class instances, `Date`, `Map`/`Set`, `undefined`, clients, sockets, or handles — use `equipResource()` for those.

# High-Frequency API Map

Use this map to pick the right API; link to the referenced doc for details instead of over-explaining.

## Define & Prompt

- `createAgent(config)` (`https://docs.rejelly.dev/en/api/core`): Define a reusable Agent; returns an async function.
- `promptAgent(schema)` (`https://docs.rejelly.dev/en/api/core`): One typed model call per generation, with schema validation retries and the default tool-call loop.
- `promptChat(options?)` (`https://docs.rejelly.dev/en/api/core`): Chat-style call returning `{ data, delta }` — `data` is the assistant text, `delta` is the new messages from this turn. Pass persisted history in via `message`; persist `delta` outside the Agent.
- `reborn(newProps?)` (`https://docs.rejelly.dev/en/api/flow`): End the current generation and re-run the handler with Agent memory preserved.
- `runWith(fn, options?)` (`https://docs.rejelly.dev/en/api/core`): Root runtime context — providers, model registry, snapshots, tracing, cancellation.

## Equip (context for the current generation)

- `equipSystem(text)` / `equipInstruction(text)` (`https://docs.rejelly.dev/en/api/equip`): System and user-facing instructions.
- `equipTool(toolDef, options?)` (`https://docs.rejelly.dev/en/api/equip`): Register a callable tool (Zod `parameters` + async `handler`). Per-tool middleware via `options.middleware`.
- `equipMemory(key, initialValue)` (`https://docs.rejelly.dev/en/api/equip`): `[value, setter]` for JSON-serializable state; lives for one Agent invocation, survives `reborn()`.
- `equipResource(key, { create, destroy })` (`https://docs.rejelly.dev/en/api/equip`): Non-serializable runtime objects with lifecycle cleanup.
- `equipScope(data)` (`https://docs.rejelly.dev/en/api/equip`): Pass JSON-serializable context down to child Agents.
- `equipBudget(config)` (`https://docs.rejelly.dev/en/api/budget`): Token and cost budgets.

## Expect (validation & dependencies)

- `expectValidator(fn)` (`https://docs.rejelly.dev/en/api/expect`): Semantic validation beyond schema shape; return an error string to make the model retry with feedback.
- `expectScope(schema)` (`https://docs.rejelly.dev/en/api/expect`): Read typed data from a parent's `equipScope()`.
- `expectResource<T>(key)` (`https://docs.rejelly.dev/en/api/expect`): Read a resource exposed by an ancestor or injected via `runWith({ providers })`.

## Effect & Middleware

- `onStream(consumer, options?)` (`https://docs.rejelly.dev/en/api/effect`): Agent-level streaming events for UI and telemetry.
- `augmentModel` / `augmentTool` / `augmentAgent` (`https://docs.rejelly.dev/en/api/core`): Reusable middleware around models, tools, and Agents.

# Going Deeper

Point users at these instead of inlining advanced material in first-contact examples:

- Custom prompt policies and orchestration beyond the default loop: `https://docs.rejelly.dev/en/api/policy`
- Tool-call loop interception (`equipToolCallLoopMiddleware`): `https://docs.rejelly.dev/en/api/core`
- Memoized computed values (`equipMemo`): `https://docs.rejelly.dev/en/api/equip`
- Testing (`createMockModel`, test contexts): `https://docs.rejelly.dev/en/api/testing`
- Snapshots and time travel (`dumpSnapshot` / `restoreSnapshot`): `https://docs.rejelly.dev/en/api/time-travel`
- Tracing, loggers, `withCustomSpan`, `equipTraceAttr`: `https://docs.rejelly.dev/en/api/debug`
- Model rate limiting (`withLimit`): `https://docs.rejelly.dev/en/api/limit-model`
- Adapters — OpenAI, MCP (`equipMCP`), LangChain: `https://docs.rejelly.dev/en/api/adapter/`. These are separate packages; do not assume they are installed unless the user's project already includes them.

# Style

- Prefer one small Agent with a clear Zod schema before introducing sub-Agents.
- Keep prompts declarative: role, task, available state, output expectations.
- Put business decisions in normal TypeScript after `promptAgent()`; use `reborn()` only when another generation is needed.
- For persistence across requests or restarts, inject the real database or SDK via `runWith({ providers })` and read it with `expectResource()` — `equipMemory` is per-invocation only.

# Version Note

This file was generated from the Rejelly docs when this version of `create-rejelly` was published, so it matches the framework version this project was scaffolded with. The links above point to the latest published documentation. For the exact API surface of the version installed in this project, the type definitions and CHANGELOG in `node_modules/@rejelly/core` are authoritative. A machine-readable snapshot of the full docs is available at https://docs.rejelly.dev/llm.txt.
