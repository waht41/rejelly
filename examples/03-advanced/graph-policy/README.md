# Graph Policy

A LangGraph-style graph — typed state, conditional edges, a cycle, parallel fan-out — implemented as a **custom prompt policy**. Core stays graph-unaware: everything here is built on the `@rejelly/core/policy` kit (`createAgentPolicy`, `executeTurn`, `executeValidation`, `normalizeMessages`, `createJsonOutputParser`, `transferJsonSchema`).

```
draft ──► critique ──► END     (both critics approve, or turn budget low)
           │  ▲
           ▼  │
          revise               (cycle back for another round)
```

## Files

- `graph-policy.ts` — mini graph runtime: `createGraphPolicy({ policyId, graph, finalText })` returns a policy function used exactly like `promptAgent` (once per generation, after equips/expects). Nodes get `GraphHelpers`: `callText` / `callStructured` (one `executeTurn` each) and `remainingTurns()`.
- `writer-critic-agent.ts` — concrete graph: writer drafts, two critic personas review **in parallel** (`Promise.all` of `executeTurn` — journaled, replay-safe), a conditional edge loops into revise or ends. The example state keeps draft and critique snapshots so the CLI can show the intermediate process before the final answer.

## What it demonstrates

1. **A graph strategy is just a policy.** The agent handler still does `equip → expect → one prompt call`; the graph (nodes, edges, state, cycles) is entirely the policy's internal view. The config–equip–policy layering needs no changes.
2. **Per-node prompts are policy args, not equips.** `equipSystem` / `equipInstruction` form the shared base every node sees; node-specific prompts live in the graph spec. Equip describes the agent's single interaction surface per generation.
3. **The validator contract.** Intermediate node outputs are parsed with the node's own parser (deliberately *not* `executeValidation`) — `expectValidator()` must apply only to the **final** output, which the policy runs through `executeValidation` before returning.
4. **Turn budget as node budget.** Every node turn (and every `callStructured` retry) consumes the generation's `maxTurnSteps`; the engine backstop is `TurnBudgetExceededError`. The critique edge reads `remainingTurns()` (from `PromptContext.usedTurnSteps`) to **degrade gracefully** — ship the current draft instead of dying mid-graph.

## Run

```bash
pnpm start -- --module=graph-policy
```

The run prints the graph path, revise count, every intermediate draft/revision, the critic feedback for each round, and the final validated draft.

## Non-goals

This is the "graph as a reasoning strategy" altitude. A full LangGraph-like product (agent-level nodes, interrupt/resume, threads) belongs in an orchestration layer **above** agents — see `fan-in-fan-out` for the sub-agent flavor of fan-out.
