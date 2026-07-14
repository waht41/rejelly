# Introduction

Rejelly is a React-inspired Agent framework that treats Agents as functions with Hooks, designed for building LLM applications.

## Core Design Philosophy

Four principles, each demonstrated in the walkthrough below:

1. **Agent as a Function**: `createAgent` wraps an async function receiving `props` — input goes in, result comes out.
2. **Prompt Building with Hooks**: The `equip` family (system / instruction / tool / memory) aggregates related logic in place, eliminating scattered string concatenation and explicit `ctx` parameters (backed by AsyncLocalStorage).
3. **Contract-Driven Output**: `promptAgent` with Zod Schema defines and validates the LLM's output structure, constraining both actions and reasoning.
4. **`reborn` Rebuilds Context**: Instead of appending intermediate steps to conversation history across rounds, each round re-renders the Prompt with the latest Memory — goal-oriented, always describing the current state and intent.

## Build an Agent Step by Step

Start from an empty shell and build a research-capable, multi-round Agent in five steps. **Each step only requires attention on the highlighted lines** (new or changed).

### 1. Skeleton: An Agent is Just a Function

```ts
import { createAgent } from '@rejelly/core';

// openaiModel is a model adapter — see the Adapter docs for construction
const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    return `TODO: Research ${topic}`;
  },
});
```

`createAgent` wraps an async function that receives `props` (here `{ topic }`) — input goes in, result comes out. Call it like any function: `await Researcher({ topic: '...' })`.

### 2. Make It Speak: Build Prompts with Hooks

```ts
import { createAgent, equipSystem, equipInstruction } from '@rejelly/core'; // [!code highlight]

const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('You are a senior researcher with critical thinking.'); // [!code highlight]
    equipInstruction(`Please write a research report on the topic "${topic}".`); // [!code highlight]
    return `TODO: Research ${topic}`;
  },
});
```

The `equip` family builds prompts in place — `equipSystem` sets the persona, `equipInstruction` assigns the task. No string concatenation, no manual `ctx` passing (the current Agent is implicitly provided by AsyncLocalStorage).

### 3. Make It Run: Contract-Driven Output

```ts
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core'; // [!code highlight]
import { z } from 'zod'; // [!code highlight]

const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('You are a senior researcher with critical thinking.');
    equipInstruction(`Please write a research report on the topic "${topic}".`);

    return await promptAgent(z.object({ // [!code highlight]
      report: z.string().describe('Research report body'), // [!code highlight]
    })); // [!code highlight]
  },
});
```

`promptAgent` calls the LLM; the Zod Schema both defines the output structure and validates it. If the LLM's output doesn't conform, the framework automatically retries with error feedback. At this point it's already a **usable single-round Agent** with return type `{ report: string }`.

### 4. Give It Tools: equipTool

```ts
import { createAgent, equipSystem, equipInstruction, equipTool, promptAgent } from '@rejelly/core'; // [!code highlight]
import { z } from 'zod';

const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    equipSystem('You are a senior researcher with critical thinking.');

    equipTool({ // [!code highlight]
      name: 'search', // [!code highlight]
      description: 'Search the web for information', // [!code highlight]
      parameters: z.object({ query: z.string() }), // [!code highlight]
      handler: async ({ query }) => `Information about "${query}"...`, // [!code highlight]
    }); // [!code highlight]

    equipInstruction(`Please write a research report on "${topic}". Use the search tool to gather information.`); // [!code highlight]

    return await promptAgent(z.object({
      report: z.string().describe('Research report body'),
    }));
  },
});
```

Once tools are registered, the LLM **decides on its own** whether to call them inside `promptAgent`; the framework automatically executes the `handler` and feeds results back to the LLM — no manual call loop needed.

### 5. Multi-Round, Goal-Oriented: equipMemory + reborn

Beyond single-round tool calls, many tasks require **iterative rounds**: research a bit, assess gaps, research more. Instead of endlessly appending to conversation history, use `reborn` to rebuild the Prompt each round, and `equipMemory` to keep state across rounds.

```ts
import { createAgent, equipSystem, equipInstruction, equipTool, equipMemory, promptAgent, reborn } from '@rejelly/core'; // [!code highlight]
import { z } from 'zod';

const Researcher = createAgent({
  id: 'researcher',
  model: openaiModel,
  handler: async ({ topic }) => {
    // Memory that survives reborn: after reborn, it returns the updated value, not the initial // [!code highlight]
    const [notes, setNotes] = equipMemory<string[]>('notes', []); // [!code highlight]

    equipSystem('You are a senior researcher with critical thinking.');

    equipTool({
      name: 'search',
      description: 'Search the web for information',
      parameters: z.object({ query: z.string() }),
      handler: async ({ query }) => `Information about "${query}"...`,
    });

    // Prompt is a "function of state": render current intelligence as a dashboard // [!code highlight]
    const board = notes.length ? notes.join('; ') : '(No intelligence yet)'; // [!code highlight]
    equipInstruction(`Topic: ${topic}. Existing intelligence: ${board}. Keep researching if insufficient, produce the final report once complete.`); // [!code highlight]

    // Contract-driven decision: LLM chooses between "continue research" and "wrap up" // [!code highlight]
    const decision = await promptAgent( // [!code highlight]
      z.discriminatedUnion('action', [ // [!code highlight]
        z.object({ // [!code highlight]
          action: z.literal('continue'), // [!code highlight]
          finding: z.string().describe('New intelligence gathered this round'), // [!code highlight]
        }), // [!code highlight]
        z.object({ // [!code highlight]
          action: z.literal('finish'), // [!code highlight]
          report: z.string().describe('Final research report'), // [!code highlight]
        }), // [!code highlight]
      ]), // [!code highlight]
    ); // [!code highlight]

    // Continue: save findings to memory, then reborn to re-run with updated dashboard // [!code highlight]
    if (decision.action === 'continue') { // [!code highlight]
      setNotes([...notes, decision.finding]); // [!code highlight]
      return reborn(); // [!code highlight]
    } // [!code highlight]

    return decision.report; // [!code highlight]
  },
});
```

`reborn()` ends the current generation and re-runs the handler with the updated `notes` — all `equip*` calls are freshly collected from the latest state, and the dashboard refreshes. This is **goal-oriented**: each round fully describes the current situation and intent, rather than appending intermediate history. Only information explicitly stored in memory carries over to the next round — noise is naturally discarded.

## Next Steps

- Use [Create Rejelly](/en/guide/create) to scaffold a project from scratch
- Use [DevTool](/en/guide/devtool) for visual debugging of Agent Traces
- Install adapter packages directly in existing projects (e.g. `pnpm add @rejelly/adapter-openai`)
- Read the [API docs](/en/api/) for the complete API reference
- Explore a complex Agent example: [evil-jelly](https://github.com/waht41/rejelly/tree/main/apps/evil-jelly) — full source for filesystem tools + MCP + CLI
