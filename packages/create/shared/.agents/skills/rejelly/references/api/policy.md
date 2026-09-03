# Policy

`promptChat` and `promptAgent` are two preset variants of the same tool-call-loop policy.
They are not two independent execution engines — they are convenience strategies composed from lower-level primitives.

These lower-level primitives include:

- `executeTurn`: Execute a single model call.
- `executeTools`: Execute tool calls returned by the model.
- `executeValidation`: Parse model output (optionally with an `OutputParser`) and run validators registered via `expectValidator`, while reporting validation telemetry events.

All three are exported by `@rejelly/core/policy`. Extended policies should be composed from these primitives, rather than copying the preset implementations.

All three primitives are **internal to policies**: they only accept a runtime derived from the current policy's
`PromptContext` (see [Runtime Seal](#runtime-seal) below).
Calling them directly in an agent handler throws `InvalidPromptRuntimeError`. If you need to make a model call
outside the preset policies, the escape hatch is to **write a small custom policy** instead of bypassing the policy boundary.

## Basic Model

A policy is a composition layer between the agent handler and the execution primitives.

A custom policy is created with the public `createAgentPolicy` factory.

The policy factory handles the common prompt lifecycle:

- Reads the current agent context.
- Ensures that a prompt policy can only be called once per run.
- Freezes the draft into a base `PromptContext` (containing `messages`, system, instruction, tools, tool loop middleware, etc.).
- Creates prompt-level telemetry spans and events.
- Calls the specific policy handler.
- Reports success or failure result metadata.

The specific policy handler then decides how to combine `executeTurn`, `executeTools`, parsing,
validation, retry, and loop logic.

## Tool-Call-Loop Policy

The shared preset loop is `runToolCallLoopPolicy`.

Its flow is:

1. Read the initial `messages` from the base `PromptContext`.
2. Fork the history via `ctx.fork({ messages })` and call `executeTurn` with that runtime.
3. If the model returns content, perform parsing and validation.
4. If validation fails, append error feedback to the current step's temporary conversation and retry within the same turn step.
5. If the model returns tool calls, execute them via `executeTools` using the same runtime view.
6. Append assistant message and tool output messages to history, then continue to the next round.
7. If `maxTurnSteps` is exceeded, throw `ToolLoopExceededError`.

### Two-Layer Turn Budget

`maxTurnSteps` operates at two layers, corresponding to two **independent** error types (deliberately unrelated by inheritance — the failure vocabulary belongs to each layer's perspective, and `actualTurns` measures different quantities):

- **Engine guardrail (`TurnBudgetExceededError`)**: `executeTurn` itself tracks the total model call count for this Generation (**validation retries included**, `actualTurns` is that count) and throws when `maxTurnSteps` is reached. This is policy-agnostic — it is a safety net against infinite loops and retry storms in extended policies. For graph/ToT policies, this is the "per-Generation node budget."
- **Tool loop non-convergence (`ToolLoopExceededError`)**: The preset tool-call-loop policy's failure perspective — the model kept returning tool calls over `maxTurnSteps` rounds without producing final content (`actualTurns` is loop rounds; validation retries within a round count as one). Suggestions to increase `maxTurnSteps` apply only to this layer.

To handle "turns exhausted" uniformly, combine two type guards: `isTurnBudgetExceededError(e) || isToolLoopExceededError(e)`.

`executeTurn` can be called concurrently within the same policy via `Promise.all` or similar; each call synchronously occupies a turn slot before the first
`await`, so concurrent branches share the same Generation's `maxTurnSteps` budget — fan-out cannot bypass the engine guardrail.

Extended policies can compare `PromptContext.usedTurnSteps` (real-time, including validation retries) against
`maxTurnSteps` before fan-out to assess remaining budget and degrade gracefully (e.g., reduce beam width),
rather than hitting the engine guardrail mid-failure.

This way the tool loop behavior is reusable, while different public prompt APIs only need to define their own input parameter and return value shapes.

## Base Runtime and Fork

Execution primitives (`executeTurn` / `executeTools`) consume a **runtime snapshot**: `messages`, system, instruction, tools, tool loop middleware, etc. — "the data needed for this model call and subsequent tool execution."

The strategy entry point receives a `PromptContext` which is the base runtime (plus `fork()`, budget, `span`, and other execution concerns). It is obtained by freezing the draft once at the policy entry. Afterwards, the draft should no longer be treated as a configuration source — when different nodes, branches, or tool sets are needed, derive a fork from the base runtime.

These are the phase boundaries within a single Agent run:

1. **Equip Phase**: The agent handler calls `equipSystem`, `equipInstruction`, `equipTool`, `expectValidator`, etc., collecting the current generation's draft.
2. **Policy Barrier**: `promptAgent`, `promptChat`, or an extended policy is called. `createAgentPolicy` crosses the barrier, freezing the draft into a base `PromptContext`.
3. **Policy Execution Phase**: The policy consumes the base runtime. When different message histories, tool sets, or tool loop middleware are needed, derive a local runtime via `ctx.fork(...)`, then pass it explicitly to the execution primitives.

In early terms this can be understood as **load before consume**; more precisely, the handler loads the base runtime, and the policy forks the runtime during execution.

The policy execution phase follows these runtime contracts:

1. **Single source**: `runtime` is a **required** parameter for `executeTurn` / `executeTools` — tools, tool loop middleware, and loop history are all read from it. The legacy fallback ("if no runtime is passed, fall back to the live draft") **has been removed** — that fallback was the root cause of primitives appearing to "work" when called directly in handlers (unfrozen draft, validators silently skipped, turn spans detached from prompt spans).
2. **Early binding**: The base `PromptContext` is frozen at the policy entry. Calling `equip*` mid-generation **does not** backfill into already-forked runtimes — configure before invoking the prompt policy.
3. **Fork shares generation-global state**: Turn budget (`maxTurnSteps` / step count), journal, `span`, and abort signal are attached to the underlying `AgentContext` and shared **by reference** across all forks. Therefore, concurrent fan-out branches forking different messages/tools **do not split budget or lose cache** (consistent with "Two-Layer Turn Budget" above). `fork()` only overrides runtime view fields — it never copies these global states.
4. **offered == executed is your responsibility**: If the **same** runtime is fed to both `executeTurn` and `executeTools`, the tool set offered to the model equals what the executor actually acknowledges. Passing different tools to each causes a mismatch between "what the model sees" and "what can be executed."
5. **messages also belong to fork**: Conversation history is no longer a scattered "external parameter" in policy-local variables. Before each turn, put the current history into a fork: `const turnRuntime = ctx.fork({ messages })`. Use this runtime's `messages` as the history during tool execution as well.

### Runtime Seal

"Primitives can only be used during the policy execution phase" is not a documentation convention — it is enforced at runtime. The mechanism is a **capability**, not an ambient flag:

- The policy barrier (`createAgentPolicy`), when freezing the base `PromptContext`, creates a seal for **this policy execution**, attached to the runtime as a hidden property (symbol key). The symbol key does not appear in `Object.keys` / JSON serialization — the seal never leaks into traces or snapshots.
- All `fork()` calls share the **same** seal by **reference** — isomorphic to how turn budget, journal, and other generation-global states are shared (see rule 3 above).
- When the policy handler returns or throws, the seal is invalidated in the barrier's `finally` block — **all forks are invalidated together**. A runtime cannot outlive its policy.

All three primitives check the seal on entry — `executeTurn` / `executeTools` **before** consuming turn budget, `executeValidation` **before** opening a validation span and writing the `validationRan` flag. The four rejection paths correspond to the `reason` field of `InvalidPromptRuntimeError` (accompanying type guard `isInvalidPromptRuntimeError`, `apiName` indicates which primitive rejected):

| `reason` | Scenario |
|---|---|
| `missing` | No runtime passed (only reachable via untyped JS calls; TypeScript treats it as a compile error) |
| `unsealed` | Hand-constructed runtime object, not derived from a policy's `PromptContext` |
| `expired` | The owning policy has already returned/thrown — includes storing `PromptContext` in an external variable and calling it later in the handler |
| `foreign` | Seal is still alive, but the runtime belongs to a different generation — e.g., smuggled into a sub-agent's handler via closure |

For `executeValidation`, `runtime` is purely a **capability credential**: it still reads validators registered via `expectValidator` from the draft, not from the runtime. The credential is mandatory because of bookkeeping safety — `executeValidation` sets `validationRan`, and this is the sole basis for the policy barrier's "validator contract bypassed" warning (see ⚠️ block below). If a handler could call it bare (e.g., misused as a generic validation utility once), this safety net would be silently dismantled.

An edge-case caveat: spreading a runtime (`{ ...runtime, tools: [...] }`) carries the **same** seal reference via the symbol property and will still be accepted — it is semantically a derived view of the same policy execution. However, `fork()` is the recommended approach — it also handles array copying and functional overrides correctly.

Being rejected by the seal **does not mean your need is invalid** — only that you are in the wrong place. To make model calls outside `promptAgent` / `promptChat` (pre-flight classification, routing, graph nodes…), write an inline custom policy — `createAgentPolicy` costs only a few lines (see skeleton below), gaining prompt spans, stream runtime, `expectValidator` contracts, and lifecycle preservation. Multiple independent LLM calls can be split into separate generations via `reborn`, or delegated to sub-agents. Manually executing a single tool (bypassing the model tool-call loop) is not restricted by this — use `callTool`.

`PromptContext.fork()` can derive these runtime fields:

```ts
const nodeRuntime = ctx.fork({
  messages: [...ctx.messages, { role: "user", content: "node prompt" }],
  tools: [searchTool, citeTool],
  toolCallLoopMiddlewares: [],
});
```

Model call options are not runtime fields — they belong to each `executeTurn` call:

```ts
const { message } = await executeTurn(nodeRuntime.messages, {
  runtime: nodeRuntime,
  toolChoice: "auto",
  additionalOptions: { temperature: 0 },
});
```

A minimal tool-loop policy skeleton:

```ts
import {
  createAgentPolicy,
  executeTools,
  executeTurn,
  executeValidation,
} from "@rejelly/core/policy";
import type { Message } from "@rejelly/core";

export const myPolicy = createAgentPolicy({
  policyId: "my-policy",
  handler: async (ctx) => {
    const messages: Message[] = [...ctx.messages];
    const delta: Message[] = [];

    while (ctx.usedTurnSteps < ctx.maxTurnSteps) {
      const runtime = ctx.fork({ messages });
      const { message } = await executeTurn(runtime.messages, { runtime });

      if (message.tool_calls?.length) {
        messages.push(message);
        delta.push(message);

        const toolRuntime = ctx.fork({ messages });
        const toolMessages = await executeTools(message.tool_calls, {
          runtime: toolRuntime,
        });
        messages.push(...toolMessages);
        delta.push(...toolMessages);
        continue;
      }

      const rawText = typeof message.content === "string" ? message.content : "";
      const validation = await executeValidation(rawText, { runtime });
      if (!validation.success) {
        throw new Error(validation.errors.join("\n"));
      }
      delta.push({ ...message, content: validation.data as string });
      return { data: validation.data, delta };
    }

    throw new Error("Policy did not converge before maxTurnSteps.");
  },
});
```

> Streaming call parameters do not belong to runtime: `toolChoice` is a per-turn parameter of `executeTurn({ toolChoice })`, provider options like temperature are overridden per-turn via `executeTurn({ additionalOptions })`. The preset tool-call-loop policy deliberately does not set `toolChoice` or `additionalOptions` — when such control is needed, compose `executeTurn` directly in an extended policy.

## Syntactic Sugar: `executeValidatedLoopTurn`

There are only three primitives (`executeTurn` / `executeTools` / `executeValidation`). The bookkeeping in the skeleton above — "call model once → if content returned, validate and retry with feedback within the **same turn step**; if tool calls returned, hand back to the outer loop" — would need to be rewritten in every tool-call-loop policy. `executeValidatedLoopTurn` solidifies it into an exported **syntactic sugar** — like `equipMemo` is to `equipMemory`: it reuses primitives, encapsulates retry counting and `AttemptsExhaustedError`, but is **not a fourth primitive** — the primitive vocabulary remains three.

```ts
import { executeValidatedLoopTurn, type LoopTurnResult } from "@rejelly/core/policy";

const result: LoopTurnResult = await executeValidatedLoopTurn({
  runtime: ctx.fork({ messages }),
  jsonSchema,          // optional: structured output
  parser,              // optional: omitted means plain-text path (validators still run)
  maxRetries: ctx.maxRetries,
});

if (result.kind === "content") {
  // Already passed executeValidation — final result + this step's delta messages
  return { data: result.data, delta: result.deltaMessages };
}
// result.kind === "tool_calls": hand result.calls to executeTools, outer loop continues
```

Its return type `LoopTurnResult` (discriminated union of `content | tool_calls`) is **deliberately loop-shaped**: the preset `runToolCallLoopPolicy` and evil-jelly's resilient chat policy both reuse it directly, differing only in the **outer loop** (how to execute tools, control tool, abort/cleanup, pendingUserInput injection, and other real product behaviors).

Both branches carry `deltaMessages` (all messages added this step), with different executable payloads (`content` gives `data`, `tool_calls` gives `calls`). The outer loop can therefore first `push(...result.deltaMessages)` universally, then branch by `kind`. This is critical: if a validation retry appends "failed output + feedback" and **then** turns into tool calls, those intra-step messages are returned via `deltaMessages` and are not lost (otherwise the recorded conversation history would misalign with what the model actually saw).

This also delineates the applicability boundary: when **different delta shaping or retry semantics** are needed, don't add parameters to this sugar — drop down to composing the three primitives yourself, just as you would switch from `equipMemo` to `equipMemory` when a custom caching strategy is needed. Sugar is convenience, not the only entry point.

## Preset Variants

### `promptAgent(schema)`

`promptAgent` is the structured output variant.

It:

- Directly accepts a Zod schema.
- Converts the Zod schema to JSON Schema and passes it to the model call.
- Uses a JSON output parser for parsing and validation.
- Returns only the validated structured data.

This variant is suitable when the agent handler needs a typed final result.

### `promptChat(options)`

`promptChat` is the chat variant.

It:

- Accepts an additional message via `options.message`.
- Optionally accepts `options.schema`.
- Returns `{ data, delta }`.
- `delta` contains only the messages newly produced by this loop, such as assistant messages, tool output, and validation feedback.

Without a schema, `data` is the validated raw text.
With a schema, `data` is the parsed structured value.

## Extending Policies

Extending prompt behavior should follow the same pattern:

1. Use `createAgentPolicy` to access the agent context, lifecycle constraints, and telemetry.
2. From the received `PromptContext`, use `ctx.fork(...)` to derive each turn/node's runtime.
3. Compose `executeTurn`, `executeTools`, `executeValidation`, and other execution primitives as needed.
4. Add parsing, validation, retry, or tool-loop behavior inside the policy.
5. Place the public API's parameter and return value shapes at the policy boundary, rather than stuffing them into the underlying primitives.

This keeps core execution primitives simple and reusable, while letting policies define application-facing product behavior.
Conversely, policies are the **only** place to use primitives: calling `executeTurn` / `executeTools` / `executeValidation` directly in a handler without going through
`createAgentPolicy` is rejected by the [Runtime Seal](#runtime-seal). Even for a one-off model call, wrap it in an inline small policy — the cost is a few lines of boilerplate, the benefit is that telemetry, validation contracts, and lifecycle have no blind spots.

> **⚠️ Policy final content must go through `executeValidation`**
>
> `expectValidator()` is a public contract of the prompt phase: validators registered by an Agent should take effect for **any** prompt policy. Validators are stored in the draft, and **the only entry point for executing them is `executeValidation`** — both preset `promptAgent` / `promptChat` call it internally.
>
> An extended policy that parses model output directly with `OutputParser.parse` (bypassing `executeValidation`) will **silently skip** registered validators, and no validation events will appear in traces / Review. The framework detects this when the policy returns successfully and prints a warning (validators exist in the draft but `executeValidation` was never called this round).
>
> Correct usage: call `executeValidation(rawText, { runtime, parser, attempt })` on the final model output (`runtime` is required, same [Runtime Seal](#runtime-seal) gate as `executeTurn`). Returns `ValidationAttemptResult`, and on failure the `failure` is a `ValidationFailure` (`failure.type`: `no_content` / `parse_error` / `schema` / `validator`) — the policy decides the feedback and retry strategy (e.g., append `errors` as a user message and retry within the same turn step). If the policy needs to incorporate other failures (e.g., "LLM call failed") into the same attempt bookkeeping, it can extend the vocabulary (e.g., `type AttemptFailure = ValidationFailure | { type: "llm_error" }`) — the failure vocabulary belongs to the policy's own perspective, and core does not provide a canonical version (`AttemptsExhaustedError.lastFailureType` is a plain string — custom vocabularies pass through this boundary directly). When `executeValidation` is called without a `parser`, it takes the plain-text path: skipping parsing, but **still** running validators — plain-text output is also subject to `expectValidator` constraints.
